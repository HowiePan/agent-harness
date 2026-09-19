import { assert } from '../../common/errors.mjs';
import { compileWorkflowFeatures } from '../../platform/workflow/definition.mjs';
import { collectionWorkflowDefinition } from './graph/definition.mjs';
import { createCollectionFeature } from './variants/collection/feature.mjs';

export const createTabletopCollectionLifecyclePlan = ({ intent, project, runId, sourceDigest }) => {
  const finalGateIds = (project.gateRecipes ?? []).filter(recipe => recipe.scope === 'final' && recipe.required !== false).map(recipe => recipe.id);
  const gateIds = ['full', 'quality', 'close'].includes(intent.action) ? finalGateIds : [];
  const quality = intent.action === 'quality';
  const selector = intent.selector ?? null;
  const batch = (project.policy?.collectionBatches ?? []).find(item => item.id === intent.target);
  assert(batch && Array.isArray(batch.gameIds) && batch.gameIds.length > 0, 'COLLECTION_BATCH_DESCRIPTOR_REQUIRED', `Project Descriptor must declare non-empty gameIds for batch ${intent.target}.`);
  assert(new Set(batch.gameIds).size === batch.gameIds.length, 'COLLECTION_GAME_DUPLICATE', `Batch ${intent.target} contains duplicate game IDs.`);
  assert(batch.gameIds.length <= Number(project.policy?.maxLogicalGames ?? 10), 'LOGICAL_GAME_LIMIT_EXCEEDED', `Batch ${intent.target} exceeds the configured logical game limit.`);
  if (selector) assert(batch.gameIds.includes(selector), 'COLLECTION_GAME_NOT_IN_BATCH', `Game ${selector} is not declared in batch ${intent.target}.`);
  const gameIds = selector ? [selector] : batch.gameIds;
  const profileConfig = {
    ...(project.policy?.profileConfigs?.['collection-batch'] ?? {}),
    activeBatch: intent.target,
    maxLogicalGames: Number(project.policy?.maxLogicalGames ?? 10),
    requiredFinalGates: gateIds,
    requireRuleReady: !['launch'].includes(intent.action),
    requireHarnessAcceptance: intent.action === 'full',
    requireIndependentReview: ['full', 'review'].includes(intent.action),
    requireUserGameAcceptance: ['full', 'accept'].includes(intent.action),
    requireBatchCloseDecision: ['full', 'close'].includes(intent.action),
    requireBatchLaunchDecision: ['full', 'produce'].includes(intent.action),
    requireFinalQualityReview: ['full', 'quality'].includes(intent.action),
  };
  const makeFeature = createCollectionFeature({ intent, batch, gateIds, sourceDigest });
  const features = compileWorkflowFeatures({ definition: collectionWorkflowDefinition, routeId: intent.action,
    templates: { 'collection-stage': ({ node, item, dependsOn }) => makeFeature({ action: node.action, gameId: item, dependsOn,
      readOnly: node.readOnly || intent.sourcePolicy === 'read-only', qualityReview: Boolean(node.qualityReview) }) },
    context: { intent, sourceDigest }, items: gameIds });
  return {
    run: { runId, profileId: 'collection-batch', profileConfig, features, runtimePluginId: project.policy?.defaultRuntimePlugin, metadata: { workflow: { id: collectionWorkflowDefinition.id, version: collectionWorkflowDefinition.version, artifactDigest: collectionWorkflowDefinition.artifactDigest } } },
    stopCondition: { type: intent.action === 'full' ? 'collection-full-complete' : 'collection-action-complete', action: intent.action, requiresFeatureCompletion: true, requiresAllFindingsResolved: ['full', 'quality'].includes(intent.action), requiredFinalGates: gateIds },
    protectedOperations: ['publication', 'commit', 'push', 'legacy-destruction', 'privilege-expansion', 'external-cutover', 'irreversible-migration'],
  };
};
