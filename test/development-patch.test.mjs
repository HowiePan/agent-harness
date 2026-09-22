import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { atomicWriteJson } from '../src/kernel/atomic-io.mjs';
import { harnessProjectRoot } from '../src/common/write-boundary.mjs';
import { createDevelopmentPatchPlan, applyDevelopmentPatchPlan, diffDevelopmentFiles } from '../src/application/development-patch.mjs';
import { developmentSourceManifestDigest, writeDevelopmentSourceManifest } from '../src/application/development-source.mjs';

const record = (path, sha256 = 'a'.repeat(64)) => ({ path, sha256, size: 1 });

test('development changes are classified by active-run compatibility', () => {
  const cases = [
    ['docs/reference/configuration-api.md', 'H0'],
    ['src/flows/delivery-lifecycle/nodes/node.mjs', 'H1'],
    ['src/flows/delivery-lifecycle/policy/delivery-lifecycle.mjs', 'H2'],
    ['src/application/harness.mjs', 'H3'],
    ['src/kernel/kernel.mjs', 'H4'],
  ];
  for (const [path, level] of cases) {
    const [change] = diffDevelopmentFiles([record(path)], [record(path, 'b'.repeat(64))]);
    assert.equal(change.level, level, path);
  }
});

test('H1 source patch records a new generation and preserves same-run continuation', async () => {
  const controlRoot = harnessProjectRoot();
  const dataRoot = resolve(controlRoot, '.tmp', 'development-patch-tests', `case-${process.pid}-${Date.now()}`);
  await mkdir(dataRoot, { recursive: true });
  try {
    const created = await writeDevelopmentSourceManifest({
      bindingId: 'patch-test', sourceRoot: controlRoot, controlRoot, dataRoot,
      configPath: resolve(controlRoot, 'examples', 'project-harness.json'), projectRoot: controlRoot,
      now: () => '2026-09-22T00:00:00.000Z',
    });
    const manifest = JSON.parse(await readFile(created.file, 'utf8'));
    const target = 'src/flows/delivery-lifecycle/nodes/node.mjs';
    const replace = files => files.map(item => item.path === target ? { ...item, sha256: '0'.repeat(64) } : item);
    manifest.files = replace(manifest.files);
    manifest.sourceIdentity.runtimeFiles = replace(manifest.sourceIdentity.runtimeFiles);
    manifest.release.artifactDigest = '1'.repeat(64);
    manifest.sourceIdentity.runtimeDigest = '1'.repeat(64);
    manifest.sourceIdentity.sourceDigest = '2'.repeat(64);
    delete manifest.manifestDigest;
    manifest.manifestDigest = developmentSourceManifestDigest(manifest);
    await atomicWriteJson(created.file, manifest, { root: dataRoot });

    const plan = await createDevelopmentPatchPlan(created.file);
    assert.equal(plan.level, 'H1');
    assert.deepEqual(plan.disposition, { sameRun: true, requiresRebind: true, requiresCoordinatorRestart: false, requiresNewRun: false });
    const output = await applyDevelopmentPatchPlan(plan, {
      commandId: 'patch-test-001',
      authorityDecision: { actor: 'test-authority', decision: 'approved' },
      now: () => '2026-09-22T00:01:00.000Z',
    });
    assert.equal(output.receipt.sameRun, true);
    assert.equal(output.receipt.level, 'H1');
    assert.equal(output.manifest.generation, 2);
    assert.equal(output.manifest.release.artifactDigest, plan.after.runtimeDigest);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
