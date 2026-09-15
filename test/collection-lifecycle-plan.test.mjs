import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { createTabletopCollectionLifecyclePlan, createTabletopCollectionProjectDescriptor } from '../src/consumers/tabletop-collection.mjs';
import { collectionBatchProfile } from '../src/profiles/collection-batch.mjs';

const games = ['doudizhu', 'gomoku', 'texas-holdem', 'chess', 'tycoon', 'liars-dice', 'junqi', 'bind-and-die', 'go', 'riichi'];
const sourceDigest = 'a'.repeat(64);
const project = () => {
  const descriptor = createTabletopCollectionProjectDescriptor({
    workspaceRoot: resolve(process.cwd(), '.tmp', 'collection-plan-workspace'),
    batches: [{ id: 'B1', status: 'active', ruleStatus: 'rule-ready', gameIds: games }],
  });
  descriptor.gateRecipes = [];
  return descriptor;
};

const intent = (action, selector = null) => ({ action, target: 'B1', selector, scope: action === 'quality' ? 'game-harness-acceptance' : action, sourcePolicy: action === 'quality' ? 'review-and-repair' : null });

test('Collection quality plan expands B1 into ten independent read-only game reviews', () => {
  const plan = createTabletopCollectionLifecyclePlan({ intent: intent('quality'), project: project(), runId: 'quality-b1', sourceDigest });
  assert.equal(plan.run.features.length, 10);
  assert.deepEqual(plan.run.features.map(feature => feature.metadata.gameId), games);
  assert.equal(plan.run.features.every(feature => feature.allowedPaths.length === 0 && feature.metadata.qualityReview), true);
  assert.equal(plan.run.features.every(feature => feature.metadata.reviewSourceDigest === sourceDigest), true);
  assert.equal(plan.run.profileConfig.requireFinalQualityReview, true);
  assert.equal(plan.run.profileConfig.requireBatchLaunchDecision, false);
  assert.equal(plan.run.profileConfig.requireHarnessAcceptance, false);
  assert.equal(plan.run.profileConfig.requireIndependentReview, false);
  assert.equal(plan.run.profileConfig.requireUserGameAcceptance, false);
  assert.equal(plan.run.profileConfig.requireBatchCloseDecision, false);
});

test('Collection full plan builds a per-game rules-to-acceptance DAG and rejects undeclared selectors', () => {
  const full = createTabletopCollectionLifecyclePlan({ intent: intent('full'), project: project(), runId: 'full-b1', sourceDigest });
  assert.equal(full.run.features.length, 50);
  for (const gameId of games) {
    const stages = full.run.features.filter(feature => feature.metadata.gameId === gameId);
    assert.deepEqual(stages.map(feature => feature.metadata.stage), ['rules', 'produce', 'quality', 'review', 'accept']);
    assert.deepEqual(stages.slice(1).map(feature => feature.dependsOn[0]), stages.slice(0, -1).map(feature => feature.id));
  }
  assert.throws(
    () => createTabletopCollectionLifecyclePlan({ intent: intent('quality', 'unknown-game'), project: project(), runId: 'bad-selector', sourceDigest }),
    error => error.code === 'COLLECTION_GAME_NOT_IN_BATCH',
  );
});

test('Collection closure requires a current clean review for every game quality root', () => {
  const features = ['g1', 'g2'].map(gameId => ({ id: `quality/B1/${gameId}`, state: 'completed', metadata: { batchId: 'B1', gameId, ruleStatus: 'rule-ready', qualityReview: true, qualityRoot: `collection:B1:${gameId}` } }));
  const config = collectionBatchProfile.validateConfig({
    activeBatch: 'B1',
    requireHarnessAcceptance: false,
    requireIndependentReview: false,
    requireUserGameAcceptance: false,
    requireBatchCloseDecision: false,
    requireBatchLaunchDecision: false,
    requireFinalQualityReview: true,
  }, features);
  const state = {
    sourceDigest,
    profile: { config },
    features,
    findings: [],
    gates: [],
    decisions: [],
    submissions: [{ featureId: features[0].id, outputSourceDigest: sourceDigest, result: { findings: [] } }],
  };
  assert.equal(collectionBatchProfile.canClose(state).reason, 'current-source-clean-quality-review-required:collection:B1:g2');
  state.submissions.push({ featureId: features[1].id, outputSourceDigest: sourceDigest, result: { findings: [] } });
  assert.deepEqual(collectionBatchProfile.canClose(state), { ok: true });
});
