import { compileWorkflowFeatures } from '../../platform/workflow/definition.mjs';
import { assert } from '../../common/errors.mjs';
import { engineWorkflowDefinition } from './graph/definition.mjs';
import { createDeliveryTemplates } from './nodes/delivery/feature.mjs';

const defaultActionPaths = Object.freeze({
  requirements: ['docs/requirements.md', 'docs/versions'],
  plan: ['docs/versions', 'docs/requirements.md'],
  implement: ['src', 'tests', 'docs'],
  scope: ['docs/versions', 'docs/requirements.md'],
  docs: ['docs/versions', 'docs/versions/INDEX.md', 'docs/integration_guide.md'],
  review: [],
  deliver: [],
});

const resolveStageGates = (gateBindings, action) => {
  const configured = gateBindings?.[action];
  if (Array.isArray(configured)) return configured;
  if (configured && typeof configured === 'object') {
    return [...(configured.pre ?? []), ...(configured.post ?? []), ...(configured.final ?? [])];
  }
  return null;
};

/**
 * Compile the action-level plan consumed by the neutral lifecycle executor.
 * This function only returns data; it never touches Authority or the workspace.
 */
export const createDeliveryLifecyclePlan = ({ intent, project, runId, sourceDigest }) => {
  assert(intent.qualityTarget, 'QUALITY_TARGET_SNAPSHOT_REQUIRED', 'Engine lifecycle planning requires an Authority-derived Quality Target snapshot.');
  if (['quality', 'full', 'deliver'].includes(intent.action)) assert(intent.knownFindingInventory, 'QUALITY_INVENTORY_SNAPSHOT_REQUIRED', 'Engine quality planning requires an Authority-derived quality inventory snapshot.');
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
  const actionPaths = intent.actionPaths ?? project.policy?.actionPaths ?? defaultActionPaths;
  const templates = createDeliveryTemplates({
    actionPaths,
    qualityRootPrefix: project.policy?.qualityRootPrefix ?? 'delivery',
    forbiddenPaths: project.workspace?.excluded ?? ['.git', '.agent-harness-data'],
  });
  const features = compileWorkflowFeatures({ definition: engineWorkflowDefinition, routeId, templates, context: { intent, sourceDigest, project } });
  const gateBindings = project.policy?.gateBindings ?? {};
  for (const feature of features) {
    const stageGates = resolveStageGates(gateBindings, feature.kind);
    feature.gatePlan = stageGates ? [...stageGates] : [...gateIds];
    feature.metadata.scope = intent.scope;
  }
  return {
    run: { runId, profileId: 'engine-delivery', profileConfig, features, metadata: { workflow: { id: engineWorkflowDefinition.id, version: engineWorkflowDefinition.version, artifactDigest: engineWorkflowDefinition.artifactDigest }, qualityTarget: structuredClone(intent.qualityTarget) } },
    stopCondition: { type: quality ? 'quality-run-complete' : full ? 'engine-full-complete' : 'engine-action-complete', action: intent.action, requiresFeatureCompletion: true, requiresAllFindingsResolved: full || quality || intent.action === 'deliver', requiredFinalGates: gateIds },
    protectedOperations: ['publication', 'commit', 'push', 'legacy-destruction', 'privilege-expansion', 'external-cutover', 'irreversible-migration'],
  };
};

export const createCardWorldLifecyclePlan = createDeliveryLifecyclePlan;
