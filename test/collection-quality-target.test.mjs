import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHarness } from '../src/application/harness.mjs';
import { loadExtensionPack } from '../src/platform/extensions/contract.mjs';
import { createTabletopCollectionProjectDescriptor } from '../integrations/legacy-consumers/collection/index.mjs';
import { createTabletopCollectionLifecyclePlan } from '../integrations/legacy-consumers/collection/index.mjs';
import { harnessTemporaryRoot } from '../src/common/write-boundary.mjs';
import { createQualityCloseoutSnapshot, createQualityRepairInventorySnapshot, deriveQualityTargetSnapshot } from '../src/platform/execution/quality-target.mjs';

const releaseIdentity = { version: '1.0.0', artifactDigest: 'a'.repeat(64), verified: true };

test('Collection lifecycle pins independent Authority quality targets for each game', async t => {
  const controlRoot = resolve(process.cwd());
  const parent = resolve(harnessTemporaryRoot(), 'collection-quality-target');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'case-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = resolve(root, 'Collection');
  await mkdir(resolve(workspaceRoot, '.git'), { recursive: true });
  await writeFile(resolve(workspaceRoot, 'README.md'), 'collection fixture\n');
  const extension = await loadExtensionPack('./integrations/legacy-consumers/collection/index.mjs', { cwd: controlRoot, controlRoot });
  const runtime = await loadExtensionPack('./integrations/codex/extensions/codex-runtime.mjs', { cwd: controlRoot, controlRoot });
  const harness = await createHarness({ controlRoot, dataRoot: resolve(root, 'data'), releaseIdentity, strictProjectIdentity: false, extensions: [extension, runtime] });
  const descriptor = createTabletopCollectionProjectDescriptor({ workspaceRoot, harness: releaseIdentity,
    batches: [{ id: 'B1', status: 'active', ruleStatus: 'rule-ready', gameIds: ['g1', 'g2'] }] });
  descriptor.gateRecipes = [];
  descriptor.extensions = descriptor.extensions.map(item => ({ ...item, digest: item.id === extension.id ? extension.digest : runtime.digest }));
  await harness.projectRegistry.register(descriptor, { expectedRevision: 0, commandId: 'collection-quality-register' });
  const plan = await harness.createLifecyclePlan({ projectId: descriptor.id, action: 'quality', target: 'B1', arguments: ['all'],
    extensionId: extension.id, executionWorkspaceRoot: workspaceRoot });
  assert.deepEqual(Object.keys(plan.intent.qualityTargets), ['g1', 'g2']);
  assert.equal(plan.run.features.every(feature => feature.metadata.knownFindingInventory?.targetDigest === plan.intent.qualityTargets[feature.metadata.gameId]?.targetDigest), true);
  assert.equal(plan.run.profileConfig.priorQualityReviews['collection:B1:g1'], 0);
  assert.equal(plan.run.profileConfig.priorQualityReviews['collection:B1:g2'], 0);
  assert.equal(plan.run.features.every(feature => feature.metadata.qualityFindingPolicy === 'repair-and-rereview'), true);
});

test('Collection repair-known and closeout use per-game Authority evidence without consuming a new review', () => {
  const firstSource = 'a'.repeat(64);
  const currentSource = 'b'.repeat(64);
  const common = { projectId: 'tabletop-collection', metadata: { workflow: { id: 'collection-batch-production' }, commandIntent: { action: 'quality', target: 'B1' } },
    revision: 1, authorityDigest: 'c'.repeat(64), createdAt: '2026-09-28T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z', submissions: [] };
  const finding = { id: 'g1:F1', severity: 'P1', summary: 'Game defect', status: 'open', featureId: 'quality/B1/g1',
    affectedPaths: ['games/g1'], evidence: ['game evidence'], evidenceRefs: ['review:evidence'] };
  const review = { ...common, runId: 'review-b1', status: 'superseded', sourceDigest: firstSource,
    features: [{ id: 'quality/B1/g1', state: 'completed', metadata: { qualityReview: true, qualityRoot: 'collection:B1:g1' } }], findings: [finding] };
  const g1Open = deriveQualityTargetSnapshot({ projectId: common.projectId, workflowId: 'collection-batch-production', target: 'B1', sourceDigest: currentSource,
    runs: [review], scopeRoot: 'collection:B1:g1' });
  const g2Open = deriveQualityTargetSnapshot({ projectId: common.projectId, workflowId: 'collection-batch-production', target: 'B1', sourceDigest: currentSource,
    scopeRoot: 'collection:B1:g2' });
  const project = createTabletopCollectionProjectDescriptor({ workspaceRoot: resolve(process.cwd(), '.tmp', 'collection-quality-planner'),
    batches: [{ id: 'B1', gameIds: ['g1', 'g2'], ruleStatus: 'rule-ready' }] });
  project.gateRecipes = [];
  const repairIntent = { action: 'quality', preset: 'repair-known', target: 'B1', scope: 'game-quality-repair', sourcePolicy: 'repair',
    qualityTargets: { g1: g1Open, g2: g2Open },
    qualityRepairInventories: { g1: createQualityRepairInventorySnapshot(g1Open), g2: createQualityRepairInventorySnapshot(g2Open) } };
  const repair = createTabletopCollectionLifecyclePlan({ intent: repairIntent, project, runId: 'repair-b1', sourceDigest: currentSource });
  assert.equal(repair.run.features.length, 1);
  assert.deepEqual(repair.run.features[0].metadata.repairFindingIds, ['g1:F1']);
  assert.equal(repair.run.profileConfig.requireFinalQualityReview, false);

  const resolved = { ...common, runId: 'repair-b1', status: 'superseded', sourceDigest: currentSource, createdAt: '2026-09-28T01:00:00.000Z',
    features: repair.run.features.map(feature => ({ ...feature, state: 'completed' })),
    metadata: { ...common.metadata, qualityRepairInventories: repair.run.metadata.qualityRepairInventories },
    findings: [{ ...finding, featureId: null, status: 'resolved', resolutionEvidenceRefs: ['repair:evidence'] }] };
  const g2Review = { ...common, runId: 'review-g2', status: 'superseded', sourceDigest: currentSource, createdAt: '2026-09-28T01:00:00.000Z',
    features: [{ id: 'quality/B1/g2', state: 'completed', metadata: { qualityReview: true, qualityRoot: 'collection:B1:g2' } }], findings: [] };
  const g1Closed = deriveQualityTargetSnapshot({ projectId: common.projectId, workflowId: 'collection-batch-production', target: 'B1', sourceDigest: currentSource,
    runs: [review, resolved], scopeRoot: 'collection:B1:g1' });
  const g2Closed = deriveQualityTargetSnapshot({ projectId: common.projectId, workflowId: 'collection-batch-production', target: 'B1', sourceDigest: currentSource,
    runs: [g2Review], scopeRoot: 'collection:B1:g2' });
  const closeIntent = { action: 'quality', preset: 'closeout', target: 'B1', scope: 'game-quality-closeout', sourcePolicy: 'read-only',
    qualityTargets: { g1: g1Closed, g2: g2Closed }, qualityCloseouts: { g1: createQualityCloseoutSnapshot(g1Closed), g2: createQualityCloseoutSnapshot(g2Closed) } };
  const closeout = createTabletopCollectionLifecyclePlan({ intent: closeIntent, project, runId: 'closeout-b1', sourceDigest: currentSource });
  assert.deepEqual(closeout.run.features.map(feature => feature.metadata.stage), ['closeout', 'closeout']);
  assert.equal(closeout.run.profileConfig.requireFinalQualityReview, false);
  assert.equal(closeout.run.profileConfig.requireQualityExitDecision, true);
});
