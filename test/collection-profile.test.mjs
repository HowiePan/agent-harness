import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectionBatchProfile } from '../integrations/legacy-consumers/collection/index.mjs';
import { createTabletopCollectionProjectDescriptor } from '../integrations/legacy-consumers/collection/variant/descriptor.mjs';
import { captureWorkspace } from '../src/common/workspace-snapshot.mjs';
import { command, feature, makeFixture, startRun } from './test-support.mjs';

const gameFeature = (game, suffix = 'main', extra = {}) => {
  const { metadata = {}, batchId = 'B1', ...rest } = extra;
  return feature(`${game}/${suffix}`, { batchId, gameId: game, ruleStatus: 'rule-ready', ...metadata }, { laneId: game, allowedPaths: [`games/${game}/${suffix}`], ...rest });
};

test('collection snapshots exclude local runtime cache changes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'collection-cache-snapshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = join(root, '.cardworld-local');
  const pnpmStore = join(root, '.pnpm-store');
  await mkdir(cache);
  await mkdir(pnpmStore);
  await writeFile(join(root, 'game.json'), '{}');
  await writeFile(join(cache, 'state.json'), 'one');
  await writeFile(join(pnpmStore, 'index.db'), 'one');
  const descriptor = createTabletopCollectionProjectDescriptor({ workspaceRoot: root });
  const before = await captureWorkspace(root, { excluded: descriptor.workspace.excluded });
  await writeFile(join(cache, 'state.json'), 'two');
  await writeFile(join(pnpmStore, 'index.db'), 'two');
  const after = await captureWorkspace(root, { excluded: descriptor.workspace.excluded });
  assert.deepEqual(before.files.map(file => file.path), ['game.json']);
  assert.equal(after.digest, before.digest);
});

test('collection descriptor scopes each game to its real Game Pack directory', () => {
  const descriptor = createTabletopCollectionProjectDescriptor({ workspaceRoot: 'F:\\CardWorld\\tabletop-collection',
    batches: [{ id: 'B1', gameIds: ['doudizhu', 'gomoku'] }] });
  assert.deepEqual(descriptor.policy.itemPaths, {
    doudizhu: ['games/presets/doudizhu'],
    gomoku: ['games/presets/gomoku'],
  });
  assert.throws(() => createTabletopCollectionProjectDescriptor({ workspaceRoot: 'F:\\CardWorld\\tabletop-collection',
    batches: [{ id: 'B1', gameIds: ['../outside'] }] }), error => error.code === 'COLLECTION_GAME_ID_INVALID');
});

test('collection keeps ten games logically active and enforces the outer batch barrier', async t => {
  const fixture = await makeFixture({ profiles: ['collection-batch'] }); t.after(() => fixture.cleanup());
  const games = Array.from({ length: 10 }, (_, index) => `game-${index + 1}`);
  await startRun(fixture, { profileId: 'collection-batch', profileConfig: { activeBatch: 'B1', batches: [{ id: 'B1', order: 1, status: 'active' }, { id: 'B2', order: 2, status: 'planned' }] }, features: [...games.map(game => gameFeature(game)), gameFeature('game-1', 'future', { batchId: 'B2' })] });
  let state = await fixture.harness.authorityStore.read(fixture.projectId, 'run');
  const beforeLaunch = await fixture.harness.dispatch(fixture.projectId, 'run', { maxConcurrency: 10 }, command(state));
  assert.equal(beforeLaunch.result.dispatches.length, 0);
  state = beforeLaunch.state;
  const launch = await fixture.harness.kernel.recordDecision(fixture.projectId, 'run', { id: 'batch:B1:launched', actor: 'user', decision: 'approved' }, command(state));
  const scheduled = await fixture.harness.dispatch(fixture.projectId, 'run', { maxConcurrency: 10 }, command(launch.state));
  assert.equal(scheduled.result.dispatches.length, 10);
  assert.equal(new Set(scheduled.result.dispatches.map(item => item.packet.feature.metadata.gameId)).size, 10);
  assert.equal(scheduled.result.dispatches.some(item => item.packet.feature.metadata.batchId === 'B2'), false);
});

test('produce Lifecycle Command yields a launch Decision bound to that exact command', () => {
  const config = collectionBatchProfile.validateConfig({ activeBatch: 'B1' }, [gameFeature('g1')]);
  const state = { profile: { config }, metadata: {
    commandIntent: { action: 'produce', target: 'B1' },
    lifecycleInvocationId: 'produce-command-1',
    lifecyclePlanDigest: 'a'.repeat(64),
  } };
  assert.deepEqual(collectionBatchProfile.commandDecisions(state), [{
    id: 'batch:B1:launched', actor: 'lifecycle-command', decision: 'approved',
    lifecycleInvocationId: 'produce-command-1', lifecyclePlanDigest: 'a'.repeat(64),
  }]);
  assert.deepEqual(collectionBatchProfile.commandDecisions({ ...state, metadata: { ...state.metadata, commandIntent: { action: 'quality', target: 'B1' } } }), []);
  assert.deepEqual(collectionBatchProfile.commandDecisions({ ...state, metadata: { ...state.metadata, commandIntent: { action: 'produce', target: 'B2' } } }), []);
});

test('shared capability has one owner and consumers depend on it', async t => {
  const fixture = await makeFixture({ profiles: ['collection-batch'] }); t.after(() => fixture.cleanup());
  const owner = gameFeature('shared', 'capability', { metadata: { capabilityKey: 'family/dice', capabilityOwner: true } });
  const consumer = gameFeature('dice-game', 'consumer', { metadata: { capabilityKey: 'family/dice', capabilityOwner: false }, dependsOn: [owner.id] });
  await startRun(fixture, { profileId: 'collection-batch', profileConfig: { activeBatch: 'B1' }, features: [owner, consumer] });
  let state = await fixture.harness.authorityStore.read(fixture.projectId, 'run');
  const launch = await fixture.harness.kernel.recordDecision(fixture.projectId, 'run', { id: 'batch:B1:launched', actor: 'user', decision: 'approved' }, command(state));
  const scheduled = await fixture.harness.dispatch(fixture.projectId, 'run', { maxConcurrency: 2 }, command(launch.state));
  assert.deepEqual(scheduled.result.dispatches.map(item => item.featureId), [owner.id]);
});

test('requested work consumes capacity and a blocked game releases its slot', async t => {
  const fixture = await makeFixture({ profiles: ['collection-batch'] }); t.after(() => fixture.cleanup());
  await startRun(fixture, { profileId: 'collection-batch', profileConfig: { activeBatch: 'B1' }, features: [gameFeature('g1'), gameFeature('g2'), gameFeature('g3')] });
  let state = await fixture.harness.authorityStore.read(fixture.projectId, 'run');
  state = (await fixture.harness.kernel.recordDecision(fixture.projectId, 'run', { id: 'batch:B1:launched', actor: 'user', decision: 'approved' }, command(state))).state;
  const first = await fixture.harness.dispatch(fixture.projectId, 'run', { maxConcurrency: 2 }, command(state));
  assert.equal(first.result.dispatches.length, 2);
  const noCapacity = await fixture.harness.dispatch(fixture.projectId, 'run', { maxConcurrency: 2 }, command(first.state));
  assert.equal(noCapacity.result.dispatches.length, 0);
  state = noCapacity.state;
  const dispatch = first.result.dispatches[0];
  const bound = await fixture.harness.bindDispatch(fixture.projectId, 'run', { dispatchId: dispatch.dispatchId, agentId: 'blocked-agent', runtimeReceipt: { runtimePluginId: 'test-runtime' } }, command(state));
  const blocked = await fixture.harness.recordResult(fixture.projectId, 'run', dispatch.dispatchId, { status: 'blocked', summary: 'local blocker', failureClass: 'dependency', changedFiles: [] }, { commandId: command().commandId });
  const replacement = await fixture.harness.dispatch(fixture.projectId, 'run', { maxConcurrency: 2 }, command(blocked.state));
  assert.equal(replacement.result.dispatches.length, 1);
  assert.equal(replacement.result.dispatches[0].featureId, 'g3/main');
});

test('batch closure separates harness, reviewer, user, and batch authorities', () => {
  const config = collectionBatchProfile.validateConfig({ activeBatch: 'B1' }, [gameFeature('g1')]);
  const state = { profile: { config }, features: [gameFeature('g1')], decisions: [], gates: [] };
  assert.equal(collectionBatchProfile.canClose(state).reason, 'game-harness-acceptance-required:g1');
  state.decisions.push({ id: 'game:g1:harness-accepted', decision: 'approved' });
  assert.equal(collectionBatchProfile.canClose(state).reason, 'game-release-review-required:g1');
  state.decisions.push({ id: 'game:g1:release-review-approved', decision: 'approved' });
  assert.equal(collectionBatchProfile.canClose(state).reason, 'game-user-acceptance-required:g1');
  state.decisions.push({ id: 'game:g1:accepted', decision: 'approved' });
  assert.equal(collectionBatchProfile.canClose(state).reason, 'batch-close-decision-required');
  state.decisions.push({ id: 'batch:B1:closed', decision: 'approved' });
  assert.deepEqual(collectionBatchProfile.canClose(state), { ok: true });
});
