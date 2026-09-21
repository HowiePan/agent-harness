import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { digestJson, sha256, withoutKeys } from '../src/common/canonical.mjs';
import { harnessTemporaryRoot } from '../src/common/write-boundary.mjs';
import { loadReleaseIdentity } from '../src/application/release-identity.mjs';
import { activeReleaseFile } from '../src/platform/registry/active-generation.mjs';
import { applyReleaseActivationPlan, createReleaseActivationPlan } from '../src/platform/maintenance/release-activation.mjs';
import { createRuntimeCompositionManifest, isMissingRuntimeCompositionError, verifyRuntimeComposition } from '../src/platform/maintenance/runtime-composition.mjs';

const createCompositionFixture = async ({ controlRoot, dataRoot }) => {
  const release = await loadReleaseIdentity({ root: controlRoot });
  const releaseManifest = JSON.parse(await readFile(resolve(controlRoot, 'release-manifest.json'), 'utf8'));
  const runtimeRoot = await mkdtemp(resolve(harnessTemporaryRoot(), 'runtime-composition-'));
  for (const item of releaseManifest.files) {
    const target = resolve(runtimeRoot, item.path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(resolve(controlRoot, item.path), target);
  }
  for (const metadataFile of releaseManifest.metadataFiles ?? ['release-manifest.json', 'sbom.spdx.json']) {
    const target = resolve(runtimeRoot, metadataFile);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(resolve(controlRoot, metadataFile), target);
  }
  const bridgePath = 'integrations/codex/agent-harness-codex/lib/hook-host-exchange.mjs';
  const bridgeBytes = Buffer.from('export const captureHookToolResult = async () => ({ captured: true });\n');
  await mkdir(dirname(resolve(runtimeRoot, bridgePath)), { recursive: true });
  await writeFile(resolve(runtimeRoot, bridgePath), bridgeBytes);
  const channelFiles = [{ path: bridgePath, size: bridgeBytes.length, sha256: sha256(bridgeBytes) }];
  const channelBody = {
    protocolVersion: '1.0',
    channel: 'codex',
    plugin: { name: 'agent-harness-codex', version: '1.0.0' },
    requiresCore: { name: 'agent-harness', version: release.version, packageDigest: release.artifactDigest },
    layout: { pluginPath: 'integrations/codex/agent-harness-codex', marketplacePath: '.agents/plugins/marketplace.json' },
    files: channelFiles,
    contentDigest: digestJson(channelFiles),
  };
  const channelManifest = { ...channelBody, artifactDigest: digestJson(channelBody) };
  await writeFile(resolve(runtimeRoot, 'codex-channel-manifest.json'), `${JSON.stringify(channelManifest, null, 2)}\n`);
  const composition = createRuntimeCompositionManifest({
    core: release,
    channels: [{ id: 'codex', version: '1.0.0', artifactDigest: channelManifest.artifactDigest, manifest: 'codex-channel-manifest.json' }],
  });
  await writeFile(resolve(runtimeRoot, 'runtime-composition.json'), `${JSON.stringify(composition, null, 2)}\n`);
  const receiptBody = {
    protocolVersion: '1.0',
    kind: 'runtime-composition-deployment-receipt',
    core: composition.core,
    channels: composition.channels,
    compositionDigest: composition.compositionDigest,
    sourceRuntimeRoot: controlRoot,
    runtimeRoot,
    fileCount: channelFiles.length,
    archive: resolve(dataRoot, 'fixture-codex.tgz'),
    deployedAt: '2026-09-21T00:00:00.000Z',
  };
  return { release, runtimeRoot, composition, receipt: { ...receiptBody, receiptDigest: digestJson(receiptBody) } };
};

test('runtime composition identity is deterministic across channel input order', () => {
  const core = { version: '1.0.0', artifactDigest: 'a'.repeat(64), verified: true };
  const alpha = { id: 'alpha', version: '1.0.0', artifactDigest: 'b'.repeat(64), manifest: 'alpha-channel-manifest.json' };
  const omega = { id: 'omega', version: '2.0.0', artifactDigest: 'c'.repeat(64), manifest: 'omega-channel-manifest.json' };
  const first = createRuntimeCompositionManifest({ core, channels: [omega, alpha] });
  const second = createRuntimeCompositionManifest({ core, channels: [alpha, omega] });
  assert.equal(first.compositionDigest, second.compositionDigest);
  assert.deepEqual(first.channels.map(channel => channel.id), ['alpha', 'omega']);
  assert.throws(
    () => createRuntimeCompositionManifest({ core, channels: [alpha, alpha] }),
    error => error.code === 'RUNTIME_COMPOSITION_CHANNEL_DUPLICATE',
  );
});

test('first runtime composition deployment recognizes an absent managed root', () => {
  assert.equal(isMissingRuntimeCompositionError({ code: 'ENOENT' }), true);
  assert.equal(isMissingRuntimeCompositionError({ code: 'MANAGED_ROOT_NOT_FOUND' }), true);
  assert.equal(isMissingRuntimeCompositionError({ code: 'RUNTIME_COMPOSITION_DIGEST_MISMATCH' }), false);
});

test('runtime composition activation preserves exact Core and Codex identities', async t => {
  const controlRoot = resolve(process.cwd());
  await mkdir(harnessTemporaryRoot(), { recursive: true });
  const dataRoot = await mkdtemp(resolve(harnessTemporaryRoot(), 'runtime-composition-data-'));
  const fixture = await createCompositionFixture({ controlRoot, dataRoot });
  t.after(() => Promise.all([rm(dataRoot, { recursive: true, force: true }), rm(fixture.runtimeRoot, { recursive: true, force: true })]));
  const verified = await verifyRuntimeComposition({ controlRoot, runtimeRoot: fixture.runtimeRoot, expectedDigest: fixture.composition.compositionDigest, expectedCore: fixture.release, expectedChannels: fixture.composition.channels });
  assert.equal(verified.compositionDigest, fixture.composition.compositionDigest);
  const plan = await createReleaseActivationPlan({ controlRoot, dataRoot, releaseIdentity: fixture.release, runtimeCompositionReceipt: fixture.receipt, now: () => '2026-09-21T00:00:01.000Z' });
  assert.equal(plan.runtime.compositionDigest, fixture.composition.compositionDigest);
  assert.deepEqual(plan.runtime.channels, fixture.composition.channels);
  const authorityDecision = { actor: 'test', decision: 'approved', action: 'release-activation', context: { planDigest: plan.planDigest } };
  const applied = await applyReleaseActivationPlan(plan, { controlRoot, dataRoot, releaseIdentity: fixture.release, commandId: 'activate-composition', authorityDecision, now: () => '2026-09-21T00:00:02.000Z' });
  assert.equal(applied.runtimeRoot, fixture.runtimeRoot);
  const pointer = JSON.parse(await readFile(activeReleaseFile(dataRoot), 'utf8'));
  assert.equal(pointer.compositionDigest, fixture.composition.compositionDigest);
  assert.deepEqual(pointer.channels, fixture.composition.channels);
});

test('runtime composition activation rejects a re-signed receipt for another channel artifact', async t => {
  const controlRoot = resolve(process.cwd());
  await mkdir(harnessTemporaryRoot(), { recursive: true });
  const dataRoot = await mkdtemp(resolve(harnessTemporaryRoot(), 'runtime-composition-tamper-'));
  const fixture = await createCompositionFixture({ controlRoot, dataRoot });
  t.after(() => Promise.all([rm(dataRoot, { recursive: true, force: true }), rm(fixture.runtimeRoot, { recursive: true, force: true })]));
  const tamperedBody = { ...withoutKeys(fixture.receipt, ['receiptDigest']), channels: fixture.receipt.channels.map(channel => ({ ...channel, artifactDigest: 'f'.repeat(64) })) };
  const tamperedReceipt = { ...tamperedBody, receiptDigest: digestJson(tamperedBody) };
  await assert.rejects(
    () => createReleaseActivationPlan({ controlRoot, dataRoot, releaseIdentity: fixture.release, runtimeCompositionReceipt: tamperedReceipt }),
    error => error.code === 'RELEASE_ACTIVATION_COMPOSITION_RECEIPT_MISMATCH',
  );
});
