import { compileWorkflowFeatures } from '../../platform/workflow/definition.mjs';
import { assert } from '../../common/errors.mjs';
import { resolveStageGates } from '../../flow-kit/primitives.mjs';
import { deliveryLifecycleWorkflowDefinition } from './graph/definition.mjs';
import { createDeliveryTemplates } from './nodes/delivery/feature.mjs';
import { repairsForFindings } from '../../flow-kit/profiles/quality-loop.mjs';
import { normalizeQualityReviewLimit } from '../../flow-kit/profiles/quality-budget.mjs';
import { assertQualityRepairInventorySnapshot } from '../../platform/execution/quality-target.mjs';

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
  implement: ['src', 'tests', 'docs'],
  scope: ['docs/versions', 'docs/requirements.md'],
  docs: ['docs/versions', 'docs/versions/INDEX.md', 'docs/integration_guide.md'],
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
  const repairOnly = intent.action === 'quality' && intent.preset === 'repair-known';
  const closeoutOnly = intent.action === 'quality' && (intent.preset === 'closeout' || repairOnly && intent.qualityRepairInventory?.findings.length === 0);
  const exhaustive = intent.action === 'quality' && intent.preset === 'release-exhaustive';
  if (['quality', 'full', 'deliver'].includes(intent.action) && !repairOnly && !closeoutOnly) assert(intent.knownFindingInventory, 'QUALITY_INVENTORY_SNAPSHOT_REQUIRED', 'Delivery quality planning requires an Authority-derived quality inventory snapshot.');
  if (repairOnly) {
    const inventory = assertQualityRepairInventorySnapshot(intent.qualityRepairInventory);
    assert(inventory.targetDigest === intent.qualityTarget.targetDigest && inventory.sourceDigest === sourceDigest, 'QUALITY_REPAIR_INVENTORY_BINDING_MISMATCH', 'Repair inventory must bind the current Authority target and source.');
  }
  if (closeoutOnly) assert(intent.qualityCloseout?.targetDigest === intent.qualityTarget.targetDigest && intent.qualityCloseout.sourceDigest === sourceDigest, 'QUALITY_CLOSEOUT_SNAPSHOT_REQUIRED', 'Independent closeout requires current authoritative evidence.');
  assert(!exhaustive || (project.policy?.majorReleaseTargets ?? []).includes(intent.target), 'QUALITY_EXHAUSTIVE_MAJOR_RELEASE_REQUIRED', 'Unbounded exhaustive review requires an explicitly declared major release target.');
  const configuredLimit = normalizeQualityReviewLimit(project.policy?.qualityReviewLimit ?? Object.assign({}, ...profileConfigKeys.map(key => project.policy?.profileConfigs?.[key] ?? {})).qualityReviewLimit);
  if (['quality', 'full', 'deliver'].includes(intent.action) && !repairOnly && !closeoutOnly) assert(configuredLimit.mode !== 'unbounded' || exhaustive, 'QUALITY_UNBOUNDED_MODE_DENIED', 'Unbounded quality review is available only to the explicit major-release exhaustive preset.');
  const qualityReviewLimit = exhaustive ? { mode: 'unbounded' } : configuredLimit;
  const priorQualityReviews = intent.qualityTarget.reviewHistory?.length ?? 0;
  if (!repairOnly && !closeoutOnly && ['quality', 'full', 'deliver'].includes(intent.action)) assert(qualityReviewLimit.mode === 'unbounded' || priorQualityReviews < 1 + qualityReviewLimit.maxRechecks, 'QUALITY_REVIEW_LIMIT_REACHED', 'The target has exhausted its configured quality review budget.');
  const finalGateIds = (project.gateRecipes ?? []).filter(recipe => recipe.scope === 'final' && recipe.required !== false).map(recipe => recipe.id);
  const gateIds = ['full', 'quality', 'deliver'].includes(intent.action) ? finalGateIds : [];
  const quality = intent.action === 'quality';
  const full = intent.action === 'full';
  const profileConfig = {
    ...Object.assign({}, ...profileConfigKeys.map(key => project.policy?.profileConfigs?.[key] ?? {})),
    requiredFinalGates: gateIds,
    requireCanonicalDecision: full || (intent.action === 'requirements' && intent.scope !== 'version-planning'),
    requireUserCodeReview: full || intent.action === 'deliver' || exhaustive,
    requireFinalQualityReview: full || quality || intent.action === 'deliver',
    qualityReviewLimit,
    priorQualityReviews,
    repairOnly,
    closeoutOnly,
    requireRoutineExitDecision: repairOnly || closeoutOnly,
  };
  if (repairOnly || closeoutOnly) profileConfig.requireFinalQualityReview = false;
  const routeId = resolveDeliveryRoute(intent);
  const actionPaths = intent.actionPaths ?? project.policy?.actionPaths ?? defaultActionPaths;
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
    : compileWorkflowFeatures({ definition: workflowDefinition, routeId, templates, context: { intent, sourceDigest, project } });
  const gateBindings = project.policy?.gateBindings ?? {};
  for (const feature of features) {
    const stageGates = resolveStageGates(gateBindings, feature.kind);
    feature.gatePlan = stageGates ? [...stageGates] : [...gateIds];
    feature.metadata.scope = intent.scope;
  }
  return {
    run: { runId, profileId, profileConfig, features, metadata: { workflow: { id: workflowDefinition.id, version: workflowDefinition.version, artifactDigest: workflowDefinition.artifactDigest }, qualityTarget: structuredClone(intent.qualityTarget), ...(repairOnly ? { qualityRepairInventory: structuredClone(intent.qualityRepairInventory) } : {}), ...(closeoutOnly ? { qualityCloseout: structuredClone(intent.qualityCloseout) } : {}) } },
    stopCondition: { type: repairOnly || closeoutOnly ? 'routine-version-exit' : quality ? 'quality-run-complete' : full ? `${stopConditionPrefix}-full-complete` : `${stopConditionPrefix}-action-complete`, action: intent.action, requiresFeatureCompletion: true, requiresAllFindingsResolved: full || quality || intent.action === 'deliver', requiredFinalGates: gateIds },
    protectedOperations: ['publication', 'commit', 'push', 'legacy-destruction', 'privilege-expansion', 'external-cutover', 'irreversible-migration'],
  };
};

export const createDeliveryLifecyclePlan = createDeliveryLifecyclePlanner();
