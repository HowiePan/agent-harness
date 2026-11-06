import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertFeatureFileAccess, projectPathAdjustments } from '../src/common/project-file-policy.mjs';
import { normalizeFeature, scheduleFeatures } from '../src/kernel/work-graph.mjs';
import { buildDispatchPacket } from '../src/kernel/kernel.mjs';
import { makeFixture, feature, startRun, dispatchAndBind, recordResult } from './test-support.mjs';

const policy = { version: 'project-files/1', mode: 'project-owned', roots: ['engine', 'scripts/engine.ps1'], protectedPaths: ['engine/secrets'] };
const owner = feature('owner', {}, { allowedPaths: ['engine/old'], forbiddenPaths: ['engine/new'] });
test('project-owned adjustment can cross planning references, never another project or protected path', () => {
  assert.doesNotThrow(() => assertFeatureFileAccess({ feature: owner, policy, path: 'engine/new/consumer.rs' }));
  assert.doesNotThrow(() => assertFeatureFileAccess({ feature: owner, policy, path: 'scripts/engine.ps1' }));
  for (const path of ['tabletop/source.rs', 'engine-neighbor/x', 'scripts/tabletop.ps1']) {
    assert.throws(() => assertFeatureFileAccess({ feature: owner, policy, path }), { code: 'PROJECT_FILE_OUTSIDE_BOUNDARY' });
  }
  assert.throws(() => assertFeatureFileAccess({ feature: owner, policy, path: process.platform === 'win32' ? 'ENGINE/SECRETS/key' : 'engine/secrets/key' }), { code: 'PROJECT_FILE_PROTECTED' });
  for (const path of ['engine/../tabletop/x', '../engine/x', 'F:/engine/x', 'engine/file:stream', 'engine/a./x', 'engine\\x']) {
    assert.throws(() => assertFeatureFileAccess({ feature: owner, policy, path }), { code: 'FEATURE_FILE_PATH_INVALID' });
  }
  assert.throws(() => assertFeatureFileAccess({ feature: { ...owner, allowedPaths: [] }, policy, path: 'engine/new/x' }), { code: 'FEATURE_READ_ONLY' });
  assert.doesNotThrow(() => assertFeatureFileAccess({ feature: { ...owner, allowedPaths: [], metadata: { sourcePolicy: 'write' } }, policy, path: 'engine/new/x' }));
});
test('cross-reference edits require concrete reasons linked to actual changed files', () => {
  const input = { feature: owner, policy, changedFiles: ['engine/new/x'], result: {} };
  assert.throws(() => projectPathAdjustments(input), { code: 'PROJECT_SCOPE_EXPLANATION_REQUIRED' });
  const result = { scopeAdjustments: [{ path: 'engine/new/x', reason: 'Update the consumer to satisfy the retained public API acceptance.' }] };
  assert.deepEqual(projectPathAdjustments({ ...input, result }), result.scopeAdjustments);
  assert.deepEqual(projectPathAdjustments({ ...input, result: { summary: 'Fix the current public API consumer.' } }),
    [{ path: 'engine/new/x', reason: 'Fix the current public API consumer.' }]);
  assert.throws(() => projectPathAdjustments({ ...input, result: { scopeAdjustments: [{ path: 'tabletop/x', reason: 'unrelated' }] } }), { code: 'PROJECT_SCOPE_ADJUSTMENT_INVALID' });
});
test('project writers serialize across disjoint reference paths; legacy scheduling remains concurrent', () => {
  const features = [feature('a', {}, { state: 'pending' }), feature('b', {}, { state: 'pending' })].map(normalizeFeature);
  assert.equal(scheduleFeatures({ features, limit: 2 }).length, 2);
  assert.equal(scheduleFeatures({ features, limit: 2, projectFilePolicy: policy }).length, 1);
  assert.equal(scheduleFeatures({ features, limit: 2, activeFeatureIds: ['a'], projectFilePolicy: policy }).length, 0);
});
test('actual project-local consumer edit is accepted and audited through Authority', async t => {
  const f = await makeFixture({ policy: { projectFilePolicy: policy } }); t.after(f.cleanup);
  await mkdir(resolve(f.workspace, 'engine/new'), { recursive: true });
  await startRun(f, { features: [owner] });
  const { dispatch, state } = await dispatchAndBind(f, 'run');
  const packet = buildDispatchPacket(state, dispatch, state.features[0]);
  assert.deepEqual(packet.projectFilePolicy, policy);
  await writeFile(resolve(f.workspace, 'engine/new/consumer.rs'), 'consumer');
  const saved = await recordResult(f, 'run', dispatch, { status: 'completed', summary: 'consumer updated', changedFiles: ['engine/new/consumer.rs'],
    scopeAdjustments: [{ path: 'engine/new/consumer.rs', reason: 'Retain API compatibility for the current owner.' }] });
  assert.equal(saved.state.features[0].state, 'completed');
  assert.ok(saved.state.events.some(event => event.type === 'feature.project-local-scope-adjusted'));
});
test('physical junction cannot grant another project write authority', async t => {
  const f = await makeFixture(); t.after(f.cleanup);
  await mkdir(resolve(f.workspace, 'engine')); await mkdir(resolve(f.root, 'tabletop'));
  try { await symlink(resolve(f.root, 'tabletop'), resolve(f.workspace, 'engine/link'), 'junction'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('Native junction creation is denied by this Host.'); throw error; }
  assert.throws(() => assertFeatureFileAccess({ feature: owner, policy, workspaceRoot: f.workspace, path: 'engine/link/new.rs' }));
});
test('an actual sibling project edit is rejected before Authority can accept it', async t => {
  const f = await makeFixture({ policy: { projectFilePolicy: policy } }); t.after(f.cleanup);
  await mkdir(resolve(f.workspace, 'tabletop'));
  await startRun(f, { features: [owner] });
  const { dispatch, state } = await dispatchAndBind(f, 'run');
  await writeFile(resolve(f.workspace, 'tabletop/source.rs'), 'outside engine ownership');
  await assert.rejects(recordResult(f, 'run', dispatch, { status: 'completed', summary: 'claim', changedFiles: ['tabletop/source.rs'] }),
    { code: 'PROJECT_FILE_OUTSIDE_BOUNDARY' });
  const after = await f.harness.authorityStore.read(f.projectId, 'run');
  assert.equal(after.revision, state.revision);
  assert.equal(after.submissions.length, 0);
});
