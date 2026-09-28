import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { atomicWriteJson } from '../src/kernel/atomic-io.mjs';
import { harnessProjectRoot } from '../src/common/write-boundary.mjs';
import { createDevelopmentPatchPlan, applyDevelopmentPatchPlan, diffDevelopmentFiles } from '../src/application/development-patch.mjs';
import { developmentSourceManifestDigest, writeDevelopmentSourceManifest } from '../src/application/development-source.mjs';
import { syncDevelopmentSource } from '../src/interfaces/cli/local-development-sync.mjs';
import { assertDevelopmentRunRecoveryEffects, hasRejectedPlanReview, selectDevelopmentRecoveryExtension } from '../src/application/development-run-recovery.mjs';

const record = (path, sha256 = 'a'.repeat(64)) => ({ path, sha256, size: 1 });

test('rejected Plan review permits H1 recovery only for the latest completed negative decision', () => {
  const state = { status: 'closure-blocked', features: [{ id: 'review', state: 'completed', metadata: { stage: 'plan-review' } }],
    submissions: [{ featureId: 'review', result: { status: 'completed', outputs: { 'plan-review': { value: { approved: false } } } } }] };
  assert.equal(hasRejectedPlanReview(state), true);
  assert.equal(hasRejectedPlanReview({ ...state, status: 'running' }), false);
  assert.equal(hasRejectedPlanReview({ ...state, submissions: [...state.submissions,
    { featureId: 'review', result: { status: 'completed', outputs: { 'plan-review': { value: { approved: true } } } } }] }), false);
});

test('development Run recovery requires terminal, identity-bound Host effects for active Leases', () => {
  const state = { projectId: 'project', runId: 'run', leases: [{ leaseId: 'lease', dispatchId: 'dispatch',
    status: 'active', agentId: 'agent', runtimeReceipt: { prompt: { promptDigest: 'prompt' },
      hostSpawnReceipt: { effectId: 'effect', sessionId: 'session', requestDigest: 'request', nativeTaskName: 'agent' } } }],
  dispatches: [{ dispatchId: 'dispatch', packetDigest: 'packet' }] };
  const effect = { effectId: 'effect', state: 'settled', outcome: { disposition: 'result-observed' }, canonicalAgentName: 'agent', nativeTaskName: 'agent',
    sessionId: 'session', requestDigest: 'request', binding: { projectId: 'project', runId: 'run', dispatchId: 'dispatch',
      packetDigest: 'packet', promptDigest: 'prompt' } };
  assert.doesNotThrow(() => assertDevelopmentRunRecoveryEffects(state, [effect]));
  assert.throws(() => assertDevelopmentRunRecoveryEffects(state, [{ ...effect, state: 'lease-bound' }]),
    error => error.code === 'DEVELOPMENT_RUN_HOST_EFFECT_UNSETTLED');
  assert.throws(() => assertDevelopmentRunRecoveryEffects(state, [{ ...effect, canonicalAgentName: 'other' }]),
    error => error.code === 'DEVELOPMENT_RUN_HOST_EFFECT_UNSETTLED');
  assert.throws(() => assertDevelopmentRunRecoveryEffects(state, [effect, { ...effect, effectId: 'pending', state: 'spawn-requested' }]),
    error => error.code === 'DEVELOPMENT_RUN_HOST_EFFECT_PENDING');
  assert.doesNotThrow(() => assertDevelopmentRunRecoveryEffects({ ...state, leases: [{ ...state.leases[0], status: 'committed' }] }, [effect]));
  assert.throws(() => assertDevelopmentRunRecoveryEffects({ ...state, leases: [] }, [effect]),
    error => error.code === 'DEVELOPMENT_RUN_HOST_LEASE_REQUIRED');
});

test('development Run recovery selects the newly bound Workflow after an H2 graph change', () => {
  const state = { profile: { id: 'engine-delivery' }, metadata: { workflow: { id: 'engine-delivery', version: '1.0.0', artifactDigest: 'old' }, workspace: { root: 'F:/CardWorld' } } };
  const intent = { workflowId: 'engine-delivery', profileId: 'engine-delivery' };
  const project = { extensions: [{ id: 'engine', digest: 'new-extension' }] };
  const installedExtensions = [{ id: 'engine', digest: 'new-extension', workflows: [{ id: 'engine-delivery', profileId: 'engine-delivery', version: '1.0.0', artifactDigest: 'new' }] }];
  assert.equal(selectDevelopmentRecoveryExtension({ state, intent, project, installedExtensions }), installedExtensions[0]);
  assert.throws(() => selectDevelopmentRecoveryExtension({ state, intent: { ...intent, workflowId: 'collection' }, project, installedExtensions }), error => error.code === 'DEVELOPMENT_RUN_SCOPE_MISMATCH');
  assert.throws(() => selectDevelopmentRecoveryExtension({ state, intent, project: { extensions: [{ id: 'engine', digest: 'other' }] }, installedExtensions }), error => error.code === 'DEVELOPMENT_RUN_SCOPE_MISMATCH');
});

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

test('dev sync rejects a mismatched local Codex manifest before changing the source binding', async () => {
  const controlRoot = harnessProjectRoot();
  const dataRoot = resolve(controlRoot, '.tmp', 'development-patch-tests', `binding-${process.pid}-${Date.now()}`);
  await mkdir(dataRoot, { recursive: true });
  try {
    const created = await writeDevelopmentSourceManifest({
      bindingId: 'binding-test', sourceRoot: controlRoot, controlRoot, dataRoot,
      configPath: resolve(controlRoot, 'examples', 'project-harness.json'), projectRoot: controlRoot,
    });
    const manifest = JSON.parse(await readFile(created.file, 'utf8'));
    const changed = manifest.files.find(item => item.path === 'docs/guides/local-debugging.md');
    changed.sha256 = '0'.repeat(64);
    manifest.sourceIdentity.supportFiles.find(item => item.path === changed.path).sha256 = changed.sha256;
    delete manifest.manifestDigest;
    manifest.manifestDigest = developmentSourceManifestDigest(manifest);
    await atomicWriteJson(created.file, manifest, { root: dataRoot });
    const bindingFile = resolve(dataRoot, 'development', 'local-codex', '.plugin-data', 'bindings.json');
    await atomicWriteJson(bindingFile, { harness: { release: { mode: 'source-link', developmentManifest: resolve(dataRoot, 'old-generation.json') }, controlRoot, dataRoot } }, { root: dataRoot });
    const before = await readFile(created.file, 'utf8');
    await assert.rejects(() => syncDevelopmentSource(created.file, { commandId: 'mismatched-binding', cwd: controlRoot }), error => error.code === 'LOCAL_CODEX_BINDING_MISMATCH');
    assert.equal(await readFile(created.file, 'utf8'), before);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
