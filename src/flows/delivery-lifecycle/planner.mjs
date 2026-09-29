import { compileWorkflowFeatures } from '../../platform/workflow/definition.mjs';
import { assert } from '../../common/errors.mjs';
import { resolveStageGates } from '../../flow-kit/primitives.mjs';
import { deliveryLifecycleWorkflowDefinition } from './graph/definition.mjs';
import { createDeliveryTemplates } from './nodes/delivery/feature.mjs';
import { repairsForFindings } from '../../flow-kit/profiles/quality-loop.mjs';
import { prepareQualityPlanning } from '../../flow-kit/profiles/quality-planning.mjs';

const resolveDeliveryRoute = intent => {
  if (intent.action === 'quality' && (intent.preset === 'closeout' || intent.preset === 'repair-known' && intent.qualityRepairInventory?.findings.length === 0)) return 'closeout';
  if (intent.action !== 'requirements') return intent.action;
  const scope = intent.scope ?? '';
  if (scope === 'version-planning') return 'plan';
  if (scope.startsWith('requirement-expansion')) return 'expand-to-plan';
  if (scope.endsWith('canonical-requirement')) return 'requirements';
  if (scope.endsWith('version-plan')) return 'direct';
  return 'requirements';
};

const defaultActionPaths = Object.freeze({
  requirements: ['docs/requirements.md', 'docs/versions'],
  plan: ['docs/versions', 'docs/requirements.md'],
  replan: ['docs/versions', 'docs/requirements.md'],
  implement: ['src', 'tests', 'docs'],
  scope: ['docs/versions', 'docs/requirements.md'],
  docs: ['docs/versions', 'docs/versions/INDEX.md', 'docs/integration_guide.md'],
  'release-prepare': [], 'release-docs': [],
  review: [],
  deliver: [],
});

/**
 * Compile the action-level plan consumed by the neutral lifecycle executor.
 * This function only returns data; it never touches Authority or the workspace.
 */
export const createDeliveryLifecyclePlanner = ({
  workflowDefinition = deliveryLifecycleWorkflowDefinition,
  profileId = 'delivery-lifecycle',
  profileConfigKeys = ['delivery-lifecycle'],
  qualityRootPrefix = 'delivery',
  stopConditionPrefix = 'delivery',
} = {}) => ({ intent, project, runId, sourceDigest }) => {
  assert(intent.qualityTarget, 'QUALITY_TARGET_SNAPSHOT_REQUIRED', 'Delivery lifecycle planning requires an Authority-derived Quality Target snapshot.');
  const prerelease = intent.action === 'prerelease';
  if (prerelease) assert(intent.developmentClearance?.status === 'development-complete' && intent.releaseDocumentation?.inventoryDigest && project.policy?.release?.packageGateId, 'PRERELEASE_PREREQUISITES_REQUIRED', 'Prerelease requires development clearance, project-owned documentation scope, and a package Gate.');
  const { repairOnly, closeoutOnly, exhaustive, qualityReviewLimit, priorQualityReviews } = prepareQualityPlanning({ intent, project, sourceDigest, profileConfigKeys,
    missingTargetMessage: 'Delivery lifecycle planning requires an Authority-derived Quality Target snapshot.',
    missingInventoryMessage: 'Delivery quality planning requires an Authority-derived quality inventory snapshot.' });
  const finalGateIds = (project.gateRecipes ?? []).filter(recipe => recipe.scope === 'final' && recipe.required !== false).map(recipe => recipe.id);
  const gateIds = ['implement', 'full', 'quality', 'deliver'].includes(intent.action) ? finalGateIds : prerelease ? [...new Set([...finalGateIds, project.policy.release.packageGateId])] : [];
  const quality = intent.action === 'quality';
  const full = intent.action === 'full';
  const profileConfig = {
    ...Object.assign({}, ...profileConfigKeys.map(key => project.policy?.profileConfigs?.[key] ?? {})),
    requiredFinalGates: gateIds,
    requireCanonicalDecision: full || (intent.action === 'requirements' && intent.scope !== 'version-planning'),
    requireUserCodeReview: full || intent.action === 'deliver' || exhaustive,
    requireFinalQualityReview: full || quality || intent.action === 'implement' || intent.action === 'deliver',
    qualityReviewLimit,
    priorQualityReviews,
    repairOnly,
    closeoutOnly,
    requireRoutineExitDecision: repairOnly || closeoutOnly,
  };
  if (repairOnly || closeoutOnly) profileConfig.requireFinalQualityReview = false;
  const routeId = resolveDeliveryRoute(intent);
  const actionPaths = prerelease
    ? { ...(project.policy?.actionPaths ?? defaultActionPaths), 'release-prepare': project.policy.release.versionPaths ?? [], 'release-docs': intent.releaseDocumentation.allowedPaths }
    : intent.actionPaths ?? project.policy?.actionPaths ?? defaultActionPaths;
  const templates = createDeliveryTemplates({
    actionPaths,
    qualityRootPrefix: project.policy?.qualityRootPrefix ?? qualityRootPrefix,
    forbiddenPaths: project.workspace?.excluded ?? ['.git', '.agent-harness-data'],
  });
  const features = repairOnly && !closeoutOnly
    ? repairsForFindings({
      feature: { id: 'authority-inventory', logicalRoot: `quality:${intent.target}`, forbiddenPaths: (project.workspace?.excluded ?? ['.git', '.agent-harness-data']).filter(path => !(project.policy?.qualityVerificationOutputs ?? []).includes(path)), gatePlan: [], metadata: { qualityRoot: `${project.policy?.qualityRootPrefix ?? qualityRootPrefix}:${intent.target}`, reviewRound: 0, qualityContext: { target: intent.target, version: intent.target, verificationOutputPaths: project.policy?.qualityVerificationOutputs ?? [] } } },
      findings: intent.qualityRepairInventory.findings, dependsOn: [], repairOnly: true,
    })
    : compileWorkflowFeatures({ definition: workflowDefinition, routeId, templates, context: { intent: prerelease ? { ...intent, actionPaths } : intent, sourceDigest, project } });
  const gateBindings = project.policy?.gateBindings ?? {};
  for (const feature of features) {
    const stageGates = resolveStageGates(gateBindings, feature.kind);
    feature.gatePlan = stageGates ? [...stageGates] : [...gateIds];
    feature.metadata.scope = intent.scope;
    if (prerelease) feature.metadata.releaseDocumentationDigest = intent.releaseDocumentation.inventoryDigest;
  }
  return {
    run: { runId, profileId, profileConfig, features, metadata: { workflow: { id: workflowDefinition.id, version: workflowDefinition.version, artifactDigest: workflowDefinition.artifactDigest }, qualityTarget: structuredClone(intent.qualityTarget), ...(intent.planRevision ? { planRevision: structuredClone(intent.planRevision) } : {}), ...(intent.changeRequest ? { changeRequest: structuredClone(intent.changeRequest) } : {}), ...(repairOnly ? { qualityRepairInventory: structuredClone(intent.qualityRepairInventory) } : {}), ...(closeoutOnly ? { qualityCloseout: structuredClone(intent.qualityCloseout) } : {}) } },
    stopCondition: { type: repairOnly || closeoutOnly ? 'routine-version-exit' : quality ? 'quality-run-complete' : full ? `${stopConditionPrefix}-full-complete` : `${stopConditionPrefix}-action-complete`, action: intent.action, requiresFeatureCompletion: true, requiresAllFindingsResolved: full || quality || intent.action === 'implement' || intent.action === 'deliver', requiredFinalGates: gateIds },
    protectedOperations: ['publication', 'commit', 'push', 'legacy-destruction', 'privilege-expansion', 'external-cutover', 'irreversible-migration'],
  };
};

export const createDeliveryLifecyclePlan = createDeliveryLifecyclePlanner();
