import { assert } from '../../common/errors.mjs';
import { compileWorkflowFeatures } from '../../platform/workflow/definition.mjs';
import { resolveStageGates } from '../../flow-kit/primitives.mjs';
import { batchProductionWorkflowDefinition } from './graph/definition.mjs';
import { createBatchFeatureFactory } from './nodes/batch/feature.mjs';
import { repairsForFindings } from '../../flow-kit/profiles/quality-loop.mjs';
import { prepareScopedQualityPlanning } from '../../flow-kit/profiles/quality-planning.mjs';

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
  extendFeatures = ({ features }) => features,
  selectorErrorCode = 'BATCH_ITEM_NOT_FOUND',
} = {}) => ({ intent, project, runId, sourceDigest }) => {
  const finalGateIds = (project.gateRecipes ?? []).filter(recipe => recipe.scope === 'final' && recipe.required !== false).map(recipe => recipe.id);
  const prerelease = intent.action === 'prerelease';
  if (prerelease) assert(intent.batchClearance?.kind === 'batch-clearance' && intent.batchClearance.sourceDigest === sourceDigest
    && intent.batchClearance.workflowId === workflowDefinition.id
    && intent.batchClearance.workflowDigest === workflowDefinition.artifactDigest
    && project.policy?.release?.packageGateId, 'BATCH_PRERELEASE_CLEARANCE_REQUIRED', 'Batch prerelease requires current authoritative closure and release policy.');
  const gateIds = ['full', 'quality', 'close'].includes(intent.action) ? finalGateIds
    : prerelease ? [...new Set([...finalGateIds, project.policy.release.packageGateId])] : [];
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
  const qualityPlanning = ['full', 'quality'].includes(intent.action)
    ? prepareScopedQualityPlanning({ intent, project, sourceDigest, scopeIds: itemIds })
    : null;
  const repairOnly = qualityPlanning?.repairOnly ?? false;
  const closeoutOnly = qualityPlanning?.closeoutOnly ?? false;
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
    requireFinalQualityReview: ['full', 'quality'].includes(intent.action) && !repairOnly && !closeoutOnly,
    qualityReviewLimit: qualityPlanning?.qualityReviewLimit ?? project.policy?.qualityReviewLimit ?? { mode: 'bounded', maxRechecks: 2 },
    priorQualityReviews: qualityPlanning?.priorQualityReviews ?? {},
    repairOnly,
    closeoutOnly,
    requireQualityExitDecision: repairOnly || closeoutOnly,
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
  const plannedFeatures = repairOnly && !closeoutOnly ? itemIds.flatMap(itemId => {
    const inventory = intent.qualityRepairInventories[itemId];
    if (!inventory.findings.length) return [];
    const root = intent.qualityTargets[itemId].scopeRoot;
    return repairsForFindings({ feature: {
      id: `authority-inventory/${itemId}`, logicalRoot: `quality:${intent.target}:${itemId}`,
      forbiddenPaths, gatePlan: [], metadata: { qualityRoot: root, reviewRound: 0,
        qualityContext: { batchId: intent.target, itemId, [itemKey]: itemId, ruleStatus: batch.ruleStatus ?? 'rule-ready' } },
    }, findings: inventory.findings, dependsOn: [], repairOnly: true });
  }) : compileWorkflowFeatures({
    definition: workflowDefinition,
    routeId: closeoutOnly ? 'closeout' : intent.action,
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
  const features = extendFeatures({ intent, project, batch, itemIds, features: plannedFeatures, sourceDigest });
  const gateBindings = project.policy?.gateBindings ?? {};
  for (const feature of features) {
    const stageGates = resolveStageGates(gateBindings, feature.kind);
    if (stageGates) feature.gatePlan = [...stageGates];
  }
  assert(features.length > 0, 'BATCH_QUALITY_FEATURES_REQUIRED', 'Quality action requires at least one review, repair, or closeout Feature.');
  return {
    run: { runId, profileId, profileConfig, features, runtimePluginId: project.policy?.defaultRuntimePlugin, metadata: {
      workflow: { id: workflowDefinition.id, version: workflowDefinition.version, artifactDigest: workflowDefinition.artifactDigest },
      ...(prerelease ? { batchClearance: structuredClone(intent.batchClearance) } : {}),
      ...(qualityPlanning ? { qualityTargets: Object.fromEntries(itemIds.map(id => [id, structuredClone(intent.qualityTargets[id])])) } : {}),
      ...(repairOnly ? { qualityRepairInventories: Object.fromEntries(itemIds.map(id => [id, structuredClone(intent.qualityRepairInventories[id])])) } : {}),
      ...(closeoutOnly ? { qualityCloseouts: Object.fromEntries(itemIds.map(id => [id, structuredClone(intent.qualityCloseouts[id])])) } : {}),
    } },
    stopCondition: { type: repairOnly || closeoutOnly ? 'batch-quality-exit' : intent.action === 'full' ? 'batch-full-complete' : 'batch-action-complete', action: intent.action, requiresFeatureCompletion: true, requiresAllFindingsResolved: ['full', 'quality'].includes(intent.action), requiredFinalGates: gateIds },
    protectedOperations: ['publication', 'commit', 'push', 'legacy-destruction', 'privilege-expansion', 'external-cutover', 'irreversible-migration'],
  };
};

export const createBatchProductionLifecyclePlan = createBatchProductionLifecyclePlanner();
