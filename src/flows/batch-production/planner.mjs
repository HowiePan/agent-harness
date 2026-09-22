import { assert } from '../../common/errors.mjs';
import { compileWorkflowFeatures } from '../../platform/workflow/definition.mjs';
import { collectionWorkflowDefinition } from './graph/definition.mjs';
import { createBatchFeatureFactory } from './nodes/batch/feature.mjs';

const resolveStageGates = (gateBindings, action) => {
  const configured = gateBindings?.[action];
  if (Array.isArray(configured)) return configured;
  if (configured && typeof configured === 'object') {
    return [...(configured.pre ?? []), ...(configured.post ?? []), ...(configured.final ?? [])];
  }
  return null;
};

export const createBatchProductionLifecyclePlan = ({ intent, project, runId, sourceDigest }) => {
  const finalGateIds = (project.gateRecipes ?? []).filter(recipe => recipe.scope === 'final' && recipe.required !== false).map(recipe => recipe.id);
  const gateIds = ['full', 'quality', 'close'].includes(intent.action) ? finalGateIds : [];
  const quality = intent.action === 'quality';
  const selector = intent.selector ?? null;
  const batches = project.policy?.batches ?? project.policy?.productionBatches ?? project.policy?.collectionBatches ?? [];
  const batch = batches.find(item => item.id === intent.target);
  const rawItems = batch?.items ?? batch?.itemIds ?? batch?.gameIds;
  assert(batch && Array.isArray(rawItems) && rawItems.length > 0, 'COLLECTION_BATCH_DESCRIPTOR_REQUIRED', `Project Descriptor must declare non-empty items for batch ${intent.target}.`);
  assert(new Set(rawItems).size === rawItems.length, 'COLLECTION_GAME_DUPLICATE', `Batch ${intent.target} contains duplicate item IDs.`);
  const maxLogicalItems = Number(project.policy?.maxLogicalItems ?? project.policy?.maxLogicalGames ?? 10);
  assert(rawItems.length <= maxLogicalItems, 'LOGICAL_GAME_LIMIT_EXCEEDED', `Batch ${intent.target} exceeds the configured logical item limit.`);
  if (selector) assert(rawItems.includes(selector), 'COLLECTION_GAME_NOT_IN_BATCH', `Item ${selector} is not declared in batch ${intent.target}.`);
  const itemIds = selector ? [selector] : rawItems;
  const itemKey = project.policy?.itemKey ?? batch?.itemKey ?? (batch?.gameIds ? 'gameId' : 'itemId');
  const profileConfig = {
    ...(project.policy?.profileConfigs?.['collection-batch'] ?? {}),
    ...(project.policy?.profileConfigs?.['batch-production'] ?? {}),
    activeBatch: intent.target,
    maxLogicalItems,
    maxLogicalGames: maxLogicalItems,
    requiredFinalGates: gateIds,
    requireRuleReady: !['launch'].includes(intent.action),
    requireHarnessAcceptance: intent.action === 'full',
    requireIndependentReview: ['full', 'review'].includes(intent.action),
    requireUserGameAcceptance: ['full', 'accept'].includes(intent.action),
    requireBatchCloseDecision: ['full', 'close'].includes(intent.action),
    requireBatchLaunchDecision: ['full', 'produce'].includes(intent.action),
    requireFinalQualityReview: ['full', 'quality'].includes(intent.action),
  };
  const itemPaths = project.policy?.itemPaths ?? (id => [`games/presets/${id}`, `items/${id}`, 'packages', 'apps', 'docs']);
  const forbiddenPaths = project.workspace?.excluded ?? ['.git', '.agent-harness-data', 'runs'];
  const makeFeature = createBatchFeatureFactory({
    intent,
    batch,
    gateIds,
    sourceDigest,
    itemKey,
    conflictPrefix: project.policy?.conflictPrefix ?? 'game',
    qualityRootPrefix: project.policy?.qualityRootPrefix ?? 'collection',
    itemPaths: typeof itemPaths === 'function' ? itemPaths : (id => itemPaths[id] ?? [`items/${id}`]),
    forbiddenPaths,
  });
  const features = compileWorkflowFeatures({
    definition: collectionWorkflowDefinition,
    routeId: intent.action,
    templates: {
      'collection-stage': ({ node, item, dependsOn }) => makeFeature({
        action: node.action,
        itemId: item,
        dependsOn,
        readOnly: node.readOnly || intent.sourcePolicy === 'read-only',
        qualityReview: Boolean(node.qualityReview),
      }),
      'batch-stage': ({ node, item, dependsOn }) => makeFeature({
        action: node.action,
        itemId: item,
        dependsOn,
        readOnly: node.readOnly || intent.sourcePolicy === 'read-only',
        qualityReview: Boolean(node.qualityReview),
      }),
    },
    context: { intent, sourceDigest, project },
    items: itemIds,
  });
  const gateBindings = project.policy?.gateBindings ?? {};
  for (const feature of features) {
    const stageGates = resolveStageGates(gateBindings, feature.kind);
    if (stageGates) feature.gatePlan = [...stageGates];
  }
  return {
    run: { runId, profileId: 'collection-batch', profileConfig, features, runtimePluginId: project.policy?.defaultRuntimePlugin, metadata: { workflow: { id: collectionWorkflowDefinition.id, version: collectionWorkflowDefinition.version, artifactDigest: collectionWorkflowDefinition.artifactDigest } } },
    stopCondition: { type: intent.action === 'full' ? 'collection-full-complete' : 'collection-action-complete', action: intent.action, requiresFeatureCompletion: true, requiresAllFindingsResolved: ['full', 'quality'].includes(intent.action), requiredFinalGates: gateIds },
    protectedOperations: ['publication', 'commit', 'push', 'legacy-destruction', 'privilege-expansion', 'external-cutover', 'irreversible-migration'],
  };
};

export const createTabletopCollectionLifecyclePlan = createBatchProductionLifecyclePlan;
