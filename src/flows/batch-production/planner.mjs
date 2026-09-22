import { assert } from '../../common/errors.mjs';
import { compileWorkflowFeatures } from '../../platform/workflow/definition.mjs';
import { batchProductionWorkflowDefinition } from './graph/definition.mjs';
import { createBatchFeatureFactory } from './nodes/batch/feature.mjs';

const resolveStageGates = (gateBindings, action) => {
  const configured = gateBindings?.[action];
  if (Array.isArray(configured)) return configured;
  if (configured && typeof configured === 'object') {
    return [...(configured.pre ?? []), ...(configured.post ?? []), ...(configured.final ?? [])];
  }
  return null;
};

export const createBatchProductionLifecyclePlanner = ({
  workflowDefinition = batchProductionWorkflowDefinition,
  profileId = 'batch-production',
  profileConfigKeys = ['batch-production'],
  resolveBatches = project => project.policy?.batches ?? [],
  resolveItems = batch => batch?.items ?? batch?.itemIds,
  defaultItemKey = 'itemId',
  defaultConflictPrefix = 'item',
  defaultQualityRootPrefix = 'batch',
  extendProfileConfig = () => ({}),
  selectorErrorCode = 'BATCH_ITEM_NOT_FOUND',
} = {}) => ({ intent, project, runId, sourceDigest }) => {
  const finalGateIds = (project.gateRecipes ?? []).filter(recipe => recipe.scope === 'final' && recipe.required !== false).map(recipe => recipe.id);
  const gateIds = ['full', 'quality', 'close'].includes(intent.action) ? finalGateIds : [];
  const quality = intent.action === 'quality';
  const selector = intent.selector ?? null;
  const batches = resolveBatches(project);
  const batch = batches.find(item => item.id === intent.target);
  const rawItems = resolveItems(batch);
  assert(batch && Array.isArray(rawItems) && rawItems.length > 0, 'BATCH_DESCRIPTOR_REQUIRED', `Project Descriptor must declare non-empty items for batch ${intent.target}.`);
  assert(new Set(rawItems).size === rawItems.length, 'BATCH_ITEM_DUPLICATE', `Batch ${intent.target} contains duplicate item IDs.`);
  const maxLogicalItems = Number(project.policy?.maxLogicalItems ?? 10);
  assert(rawItems.length <= maxLogicalItems, 'LOGICAL_ITEM_LIMIT_EXCEEDED', `Batch ${intent.target} exceeds the configured logical item limit.`);
  if (selector) assert(rawItems.includes(selector), selectorErrorCode, `Item ${selector} is not declared in batch ${intent.target}.`);
  const itemIds = selector ? [selector] : rawItems;
  const itemKey = project.policy?.itemKey ?? batch?.itemKey ?? defaultItemKey;
  const requireUserItemAcceptance = ['full', 'accept'].includes(intent.action);
  const profileConfig = {
    ...Object.assign({}, ...profileConfigKeys.map(key => project.policy?.profileConfigs?.[key] ?? {})),
    activeBatch: intent.target,
    maxLogicalItems,
    requiredFinalGates: gateIds,
    requireRuleReady: !['launch'].includes(intent.action),
    requireHarnessAcceptance: intent.action === 'full',
    requireIndependentReview: ['full', 'review'].includes(intent.action),
    requireUserItemAcceptance,
    ...extendProfileConfig({ requireUserItemAcceptance, batch, itemIds }),
    requireBatchCloseDecision: ['full', 'close'].includes(intent.action),
    requireBatchLaunchDecision: ['full', 'produce'].includes(intent.action),
    requireFinalQualityReview: ['full', 'quality'].includes(intent.action),
  };
  const itemPaths = project.policy?.itemPaths ?? (id => [`items/${id}`, 'packages', 'apps', 'docs']);
  const forbiddenPaths = project.workspace?.excluded ?? ['.git', '.agent-harness-data', 'runs'];
  const makeFeature = createBatchFeatureFactory({
    intent,
    batch,
    gateIds,
    sourceDigest,
    itemKey,
    conflictPrefix: project.policy?.conflictPrefix ?? defaultConflictPrefix,
    qualityRootPrefix: project.policy?.qualityRootPrefix ?? defaultQualityRootPrefix,
    itemPaths: typeof itemPaths === 'function' ? itemPaths : (id => itemPaths[id] ?? [`items/${id}`]),
    forbiddenPaths,
  });
  const features = compileWorkflowFeatures({
    definition: workflowDefinition,
    routeId: intent.action,
    templates: {
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
    run: { runId, profileId, profileConfig, features, runtimePluginId: project.policy?.defaultRuntimePlugin, metadata: { workflow: { id: workflowDefinition.id, version: workflowDefinition.version, artifactDigest: workflowDefinition.artifactDigest } } },
    stopCondition: { type: intent.action === 'full' ? 'batch-full-complete' : 'batch-action-complete', action: intent.action, requiresFeatureCompletion: true, requiresAllFindingsResolved: ['full', 'quality'].includes(intent.action), requiredFinalGates: gateIds },
    protectedOperations: ['publication', 'commit', 'push', 'legacy-destruction', 'privilege-expansion', 'external-cutover', 'irreversible-migration'],
  };
};

export const createBatchProductionLifecyclePlan = createBatchProductionLifecyclePlanner();
