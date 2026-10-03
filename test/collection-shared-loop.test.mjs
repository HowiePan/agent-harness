import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createTabletopCollectionLifecyclePlan, createTabletopCollectionProjectDescriptor, collectionBatchProfile } from '../integrations/legacy-consumers/collection/index.mjs';
import { collectionCapabilityFollowUps, collectionExhaustion } from '../integrations/legacy-consumers/collection/variant/shared-capabilities.mjs';
import { validateWorkGraph } from '../src/kernel/work-graph.mjs';
import { shouldContinueCollectionProgress } from '../src/application/lifecycle-execution-service.mjs';
import { verifyCollectionScenarioInventories } from '../src/application/collection-exhaustion.mjs';
import { makeFixture, command, dispatchAndBind, recordResult } from './test-support.mjs';

const games = ['doudizhu', 'gomoku', 'texas-holdem', 'chess', 'tycoon', 'liars-dice', 'junqi', 'bind-and-die', 'go', 'riichi'];
const project = () => createTabletopCollectionProjectDescriptor({ workspaceRoot: resolve(process.cwd(), '.tmp', 'collection-shared-plan'),
  batches: [{ id: 'B1', gameIds: games, ruleStatus: 'rule-ready' }] });
const plan = () => createTabletopCollectionLifecyclePlan({ intent: { action: 'produce', target: 'B1', scope: 'round-production' },
  project: project(), runId: 'shared-loop', sourceDigest: 'a'.repeat(64) });
const audit = (blockerKind = 'collection-capability') => ({
  requiredScenarios: ['contract', 'round'], readyRemaining: [],
  scenarioAudit: [
    { id: 'contract', disposition: 'passed', evidenceRefs: ['fixture:contract'] },
    { id: 'round', disposition: 'blocked', blockerKind, evidenceRefs: ['fixture:round'] },
  ],
});
const request = { key: 'collection-shared', summary: 'Map a reusable public capability.', scenarioIds: ['round'], evidenceRefs: ['fixture:round'] };
const gameResult = (status, blockerKind = 'collection-capability') => ({ status, summary: 'Current scenario audit', changedFiles: [],
  ...(status === 'blocked' ? { blocker: { kind: blockerKind, summary: 'Published artifact or Collection gap.' } } : {}),
  outputs: { produce: { schemaId: 'batch-produce-v1', evidenceRefs: ['fixture:round'], value: {
    changedFiles: [], ...audit(blockerKind), ...(blockerKind === 'collection-capability' ? { sharedCapabilityRequest: request } : {}),
  } } },
});

test('one B1 produce plan schedules a single shared owner before ten scoped game producers', () => {
  const planned = plan();
  const features = planned.run.features;
  const owner = features.find(feature => feature.metadata.capabilityOwner);
  assert.equal(features.length, 11);
  assert.deepEqual(owner.allowedPaths, ['packages', 'apps', 'docs', 'scripts']);
  assert(owner.forbiddenPaths.includes('engine-artifact.lock.json'));
  assert(owner.forbiddenPaths.includes('docs/rules'));
  assert.deepEqual(owner.gatePlan, ['collection-shared-verify']);
  assert.deepEqual(owner.metadata.verificationOutputPaths, planned.run.features.find(feature => feature.metadata.gameId === 'texas-holdem').metadata.verificationOutputPaths);
  assert(owner.metadata.verificationOutputPaths.includes('.cardworld-local'));
  assert(owner.metadata.verificationOutputPaths.includes('apps/web/dist'));
  assert(owner.metadata.verificationOutputPaths.includes('apps/mobile/dist'));
  assert(!owner.forbiddenPaths.includes('.cardworld-local'));
  assert(owner.forbiddenPaths.includes('node_modules'));
  assert.deepEqual(planned.stopCondition.requiredFinalGates, ['collection-produce-exhaustion-verify']);
  for (const game of features.filter(feature => feature.metadata.stage === 'produce')) {
    assert.deepEqual(game.allowedPaths, [`games/presets/${game.metadata.gameId}`]);
    assert(game.dependsOn.includes(owner.id));
    assert.deepEqual(game.metadata.verificationOutputPaths, owner.metadata.verificationOutputPaths);
  }
});

test('B1 refuses an old Descriptor without the shared verification gates', () => {
  const stale = project();
  stale.gateRecipes = stale.gateRecipes.filter(recipe => recipe.id !== 'collection-shared-verify');
  assert.throws(() => createTabletopCollectionLifecyclePlan({ intent: { action: 'produce', target: 'B1', scope: 'round-production' },
    project: stale, runId: 'stale-shared-plan', sourceDigest: 'a'.repeat(64) }),
  error => error.code === 'COLLECTION_SHARED_DESCRIPTOR_STALE');
});

test('B1 refuses a Descriptor without declared check:ci verification outputs', () => {
  const stale = project();
  delete stale.policy.qualityVerificationOutputs;
  assert.throws(() => createTabletopCollectionLifecyclePlan({ intent: { action: 'produce', target: 'B1', scope: 'round-production' },
    project: stale, runId: 'stale-verification-plan', sourceDigest: 'a'.repeat(64) }),
  error => error.code === 'COLLECTION_VERIFICATION_OUTPUTS_REQUIRED');
});

test('a Collection handoff appends an owner and a dependent same-run game continuation', () => {
  const features = plan().run.features;
  const game = features.find(feature => feature.metadata.gameId === 'texas-holdem');
  const state = { features, submissions: [], profile: { config: { requireBlockedScenarioAudit: true } }, findings: [] };
  const result = gameResult('completed');
  assert.deepEqual(collectionBatchProfile.validateResult({ state, feature: game, result }), { ok: true });
  const followUps = collectionCapabilityFollowUps({ state, feature: game, result });
  assert.equal(followUps.length, 2);
  assert.equal(followUps[0].metadata.capabilityOwner, true);
  assert.deepEqual(followUps[0].dependsOn, [game.id]);
  assert.deepEqual(followUps[1].dependsOn, [followUps[0].id]);
  assert.deepEqual(followUps[1].allowedPaths, game.allowedPaths);
  assert.deepEqual(followUps[0].metadata.verificationOutputPaths, game.metadata.verificationOutputPaths);
  assert.deepEqual(followUps[1].metadata.verificationOutputPaths, game.metadata.verificationOutputPaths);
  validateWorkGraph([...features, ...followUps]);
});

test('a changed shared owner rechecks already terminal consumers, without editing their packs', () => {
  const features = plan().run.features;
  const requesting = features.find(feature => feature.metadata.gameId === 'texas-holdem');
  const other = features.find(feature => feature.metadata.gameId === 'junqi');
  requesting.state = 'completed';
  other.state = 'blocked';
  other.blocker = { kind: 'engine-artifact', summary: 'old audit' };
  const handoff = collectionCapabilityFollowUps({ state: { features, submissions: [] }, feature: requesting, result: gameResult('completed') });
  const owner = handoff[0];
  owner.state = 'completed';
  const rechecks = collectionCapabilityFollowUps({ state: { features: [...features, ...handoff], submissions: [] }, feature: owner,
    result: { status: 'completed', summary: 'mapped', changedFiles: ['packages/game-compiler/src/index.ts'] } });
  assert.equal(rechecks.length, 1);
  assert.equal(rechecks[0].metadata.gameId, 'junqi');
  assert.deepEqual(rechecks[0].dependsOn, [owner.id]);
  assert.deepEqual(rechecks[0].allowedPaths, other.allowedPaths);
});

test('a no-change owner cannot cause an endless handoff and reports Collection attention', () => {
  const features = plan().run.features;
  const game = features.find(feature => feature.metadata.gameId === 'texas-holdem');
  const first = collectionCapabilityFollowUps({ state: { features, submissions: [] }, feature: game, result: gameResult('completed') });
  const [owner, continuation] = first;
  const state = { features: [...features, ...first], submissions: [{ featureId: owner.id, inputSourceDigest: 'a', outputSourceDigest: 'a' }],
    profile: { config: { requireBlockedScenarioAudit: true } }, findings: [] };
  assert.equal(collectionBatchProfile.validateResult({ state, feature: continuation, result: gameResult('completed') }).ok, false);
  assert.deepEqual(collectionBatchProfile.validateResult({ state, feature: continuation, result: gameResult('blocked') }), { ok: true });
});

test('exhaustion projection distinguishes verified engine-only residuals from Collection work', () => {
  const features = plan().run.features;
  const owner = features.find(feature => feature.metadata.capabilityOwner);
  const game = features.find(feature => feature.metadata.gameId === 'texas-holdem');
  owner.state = 'completed';
  game.state = 'blocked';
  game.blocker = { kind: 'engine-artifact', summary: 'public API gap' };
  const subset = { features: [owner, game], submissions: [{ featureId: game.id, result: gameResult('blocked', 'engine-artifact') }] };
  assert.deepEqual(collectionExhaustion(subset).engineBlocked, ['texas-holdem']);
  assert.equal(collectionExhaustion(subset).onlyEngineRemaining, true);
  owner.state = 'blocked';
  assert.equal(collectionExhaustion(subset).onlyEngineRemaining, false);
});

test('verified Collection source progress continues within the same visible command and cycles stop', () => {
  const game = plan().run.features.find(feature => feature.metadata.gameId === 'texas-holdem');
  const submission = { submissionId: 's1', featureId: game.id, inputSourceDigest: 'a', outputSourceDigest: 'b',
    changedFiles: ['games/presets/texas-holdem/definition.json'] };
  const result = { status: 'blocked', failureClass: 'collection-game-incomplete' };
  const state = { profile: { id: 'collection-batch' }, features: [{ ...game, state: 'blocked' }], submissions: [submission],
    attempts: { [`${game.logicalRoot}:collection-game-incomplete`]: { failures: 1, exhausted: false } } };
  assert.equal(shouldContinueCollectionProgress({ feature: game, result, state, submission }), true);
  state.submissions.unshift({ submissionId: 'older', featureId: game.id, inputSourceDigest: 'b', outputSourceDigest: 'c' });
  assert.equal(shouldContinueCollectionProgress({ feature: game, result, state, submission }), false);
});

test('engine-only conclusion checks the latest audit against Game Pack manifests', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'collection-exhaustion-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gameDir = resolve(root, 'games', 'presets', 'texas-holdem');
  await mkdir(gameDir, { recursive: true });
  await writeFile(resolve(gameDir, 'manifest.json'), JSON.stringify({ id: 'texas-holdem', requiredScenarios: ['contract', 'round'] }));
  const game = plan().run.features.find(feature => feature.metadata.gameId === 'texas-holdem');
  const state = { features: [game], submissions: [{ featureId: game.id, result: gameResult('blocked', 'engine-artifact') }] };
  assert.equal((await verifyCollectionScenarioInventories({ workspaceRoot: root, state })).ok, true);
  state.submissions[0].result.outputs.produce.value.requiredScenarios.pop();
  assert.deepEqual((await verifyCollectionScenarioInventories({ workspaceRoot: root, state })).mismatches,
    [{ gameId: 'texas-holdem', reason: 'required-scenario-audit-mismatch' }]);
});

test('Kernel persists a shared handoff and schedules the owner before its game continuation', async t => {
  const fixture = await makeFixture({ profiles: ['collection-batch'] });
  t.after(() => fixture.cleanup());
  const planned = plan();
  const owner = planned.run.features.find(feature => feature.metadata.capabilityOwner);
  const game = planned.run.features.find(feature => feature.metadata.gameId === 'texas-holdem');
  await fixture.harness.startRun({ projectId: fixture.projectId, runId: 'run', profileId: 'collection-batch', features: [owner, game],
    profileConfig: { activeBatch: 'B1', requireBatchLaunchDecision: false, requireBlockedScenarioAudit: true },
    metadata: { commandIntent: { action: 'produce', target: 'B1' } }, executionAuthorizationEvidence: { explicitUnattended: true } }, command());
  const first = await dispatchAndBind(fixture, 'run');
  assert.equal(first.dispatch.featureId, owner.id);
  await recordResult(fixture, 'run', first.dispatch, { status: 'completed', summary: 'shared baseline exhausted', changedFiles: [],
    outputs: { produce: { schemaId: 'batch-produce-v1', evidenceRefs: ['fixture:owner'], value: { changedFiles: [], collectionRemaining: [] } } } });
  const second = await dispatchAndBind(fixture, 'run');
  assert.equal(second.dispatch.featureId, game.id);
  const committed = await recordResult(fixture, 'run', second.dispatch, gameResult('completed'));
  const pending = committed.state.features.filter(feature => feature.state === 'pending');
  assert.equal(pending.length, 2);
  assert.equal(pending[0].metadata.capabilityOwner, true);
  assert.deepEqual(pending[1].dependsOn, [pending[0].id]);
  const third = await dispatchAndBind(fixture, 'run');
  assert.equal(third.dispatch.featureId, pending[0].id);
});
