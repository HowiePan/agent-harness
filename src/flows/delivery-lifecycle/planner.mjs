import { compileWorkflowFeatures } from '../../platform/workflow/definition.mjs';
import { engineWorkflowDefinition } from './graph/definition.mjs';
import { engineTemplates } from './variants/cardworld/feature.mjs';

/**
 * Compile the action-level plan consumed by the neutral lifecycle executor.
 * This function only returns data; it never touches Authority or the workspace.
 */
export const createCardWorldLifecyclePlan = ({ intent, project, runId, sourceDigest }) => {
  const finalGateIds = (project.gateRecipes ?? []).filter(recipe => recipe.scope === 'final' && recipe.required !== false).map(recipe => recipe.id);
  const gateIds = ['full', 'quality', 'deliver'].includes(intent.action) ? finalGateIds : [];
  const quality = intent.action === 'quality';
  const full = intent.action === 'full';
  const profileConfig = {
    ...(project.policy?.profileConfigs?.['engine-delivery'] ?? {}),
    requiredFinalGates: gateIds,
    requireCanonicalDecision: full || (intent.action === 'requirements' && intent.scope !== 'version-planning'),
    requireUserCodeReview: full || intent.action === 'deliver',
    requireFinalQualityReview: full || quality || intent.action === 'deliver',
  };
  const routeId = intent.action === 'requirements' && intent.scope === 'version-planning' ? 'plan' : intent.action;
  const features = compileWorkflowFeatures({ definition: engineWorkflowDefinition, routeId, templates: engineTemplates, context: { intent, sourceDigest } });
  for (const feature of features) {
    feature.gatePlan = [...gateIds];
    feature.metadata.scope = intent.scope;
  }
  return {
    run: { runId, profileId: 'engine-delivery', profileConfig, features, metadata: { workflow: { id: engineWorkflowDefinition.id, version: engineWorkflowDefinition.version, artifactDigest: engineWorkflowDefinition.artifactDigest } } },
    stopCondition: { type: quality ? 'quality-run-complete' : full ? 'engine-full-complete' : 'engine-action-complete', action: intent.action, requiresFeatureCompletion: true, requiresAllFindingsResolved: full || quality || intent.action === 'deliver', requiredFinalGates: gateIds },
    protectedOperations: ['publication', 'commit', 'push', 'legacy-destruction', 'privilege-expansion', 'external-cutover', 'irreversible-migration'],
  };
};
