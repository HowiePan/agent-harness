import { assert } from '../../../common/errors.mjs';
import { defineNodeTaskContract, taskFeatureProjection } from '../../../common/task-contract.mjs';
import { approvalSatisfied } from '../../../flow-kit/primitives.mjs';
import { createQualityFollowUpFeatures, createQualityGateDiagnosticReview, hasCurrentCleanQualityReview, qualityReviewNoProgress, validateQualityReviewPolicies } from '../../../flow-kit/profiles/quality-loop.mjs';
import { normalizeQualityReviewLimit, qualityReviewBudgetExhausted } from '../../../flow-kit/profiles/quality-budget.mjs';
import { planApprovalSatisfied } from '../plan-approval.mjs';

export const DELIVERY_STAGES = Object.freeze([
  'requirement-intake', 'requirement-expansion', 'canonical-requirement', 'version-planning', 'plan-review', 'implementation',
  'scope-resolution', 'docs-closeout', 'quality', 'quality-repair', 'quality-recheck', 'quality-closeout', 'release-preparation', 'release-documentation', 'user-code-review', 'delivery-receipt',
]);

const stageIndex = stage => DELIVERY_STAGES.indexOf(stage);
const planReviewApproved = state => {
  const reviews = state.submissions?.filter(submission =>
    state.features.some(feature => feature.id === submission.featureId && feature.metadata?.stage === 'plan-review')
    && submission.result?.status === 'completed') ?? [];
  return reviews.length > 0 && reviews.at(-1).result.outputs?.['plan-review']?.value?.approved === true;
};

export const createDeliveryLifecycleProfile = (id = 'delivery-lifecycle') => Object.freeze({
  id,
  version: '1.0.0',

  validateConfig(config) {
    assert(config.priorQualityReviews === undefined || (Number.isInteger(config.priorQualityReviews) && config.priorQualityReviews >= 0), 'QUALITY_REVIEW_HISTORY_INVALID', 'Prior quality review count must be a non-negative integer.');
    return {
      requireCanonicalDecision: config.requireCanonicalDecision !== false,
      requireUserCodeReview: config.requireUserCodeReview !== false,
      requiredFinalGates: [...new Set(config.requiredFinalGates ?? [])],
      requireFinalQualityReview: config.requireFinalQualityReview === true,
      qualityReviewLimit: normalizeQualityReviewLimit(config.qualityReviewLimit),
      priorQualityReviews: config.priorQualityReviews ?? 0,
      repairOnly: config.repairOnly === true,
      closeoutOnly: config.closeoutOnly === true,
      requireRoutineExitDecision: config.requireRoutineExitDecision === true,
    };
  },

  validateRun(state) {
    validateQualityReviewPolicies(state.features);
    for (const feature of state.features) {
      const stage = feature.metadata.stage;
      assert(DELIVERY_STAGES.includes(stage), 'DELIVERY_STAGE_INVALID', `Delivery Feature ${feature.id} has an invalid stage: ${stage}`);
    }
    return state;
  },

  validateResult({ state, feature, result }) {
    if (feature.metadata?.stage === 'version-planning' && result.status === 'completed' && Array.isArray(result.followUpFeatures) && result.followUpFeatures.length > 0) {
      return { ok: false, reason: 'planning-proposals-must-use-typed-plan-output' };
    }
    if (feature.metadata?.stage === 'version-planning' && result.status === 'completed') {
      const proposals = result.outputs?.plan?.value?.proposedFeatures ?? [];
      if (proposals.some(item => (item.projectId === state.projectId) !== (item.disposition === 'project-owned'))) {
        return { ok: false, reason: 'planning-proposal-project-disposition-mismatch' };
      }
    }
    // A negative review is a valid decision. Preserve its findings instead of
    // rejecting the result and retrying the same unchanged plan.
    if (feature.metadata?.stage === 'plan-review' && result.status === 'completed') return { ok: true };
    if (feature.metadata?.stage === 'release-preparation' && result.status === 'completed') {
      const prepared = result.outputs?.['release-prepare']?.value;
      return { ok: prepared?.version === state.metadata?.commandIntent?.target, reason: 'release-version-identity-mismatch' };
    }
    if (feature.metadata?.stage === 'release-documentation' && result.status === 'completed') {
      const audit = result.outputs?.['release-docs']?.value;
      const audited = audit?.auditedFiles;
      return { ok: Array.isArray(audited) && new Set(audited).size === audited.length && Array.isArray(audit.unresolved) && audit.unresolved.length === 0, reason: 'release-documentation-audit-incomplete' };
    }
    if (feature.metadata?.stage !== 'quality-closeout' || result.status !== 'completed') return { ok: true };
    const pinned = state.metadata?.qualityCloseout;
    const reported = result.outputs?.closeout?.value;
    return { ok: reported?.ready === true && reported.priorRunId === pinned?.priorRunId && reported.sourceDigest === state.sourceDigest && state.sourceDigest === pinned?.sourceDigest, reason: 'quality-closeout-evidence-mismatch' };
  },

  canDispatch(feature, state) {
    const stage = feature.metadata.stage;
    const config = state.profile.config;
    if (stageIndex(stage) > stageIndex('plan-review') && state.features.some(item => item.metadata?.stage === 'plan-review') && !planReviewApproved(state)) {
      return { ok: false, reason: 'plan-scope-review-not-approved' };
    }
    if (stageIndex(stage) > stageIndex('plan-review') && state.features.some(item => item.metadata?.stage === 'plan-review') && !planApprovalSatisfied(state)) {
      return { ok: false, reason: 'implementation-plan-user-approval-required' };
    }
    if (stage === 'implementation' && state.metadata?.commandIntent?.action === 'implement' && !state.features.some(item => item.metadata?.stage === 'plan-review') && !state.metadata?.approvedPlan) {
      return { ok: false, reason: 'implementation-plan-user-approval-required' };
    }
    if (config.requireCanonicalDecision && stageIndex(stage) > stageIndex('canonical-requirement')) {
      const approved = approvalSatisfied(state, 'canonical-requirement-approved');
      if (!approved) return { ok: false, reason: 'canonical-requirement-decision-required' };
    }
    const earlier = state.features.filter(candidate => stageIndex(candidate.metadata.stage) < stageIndex(stage));
    const incompleteEarlier = earlier.filter(candidate => candidate.state !== 'completed' && !candidate.metadata.nonBlockingStage);
    return incompleteEarlier.length ? { ok: false, reason: 'earlier-stage-incomplete', blockers: incompleteEarlier.map(item => item.id) } : { ok: true };
  },

  createFollowUpFeatures(input) {
    const { feature, result } = input;
    const qualityRepairs = createQualityFollowUpFeatures(input);
    if (feature.metadata?.stage !== 'implementation' || !feature.metadata?.allowDynamicDecomposition || !Array.isArray(result?.followUpFeatures)) return qualityRepairs;
    const planned = result.followUpFeatures.map(item => {
      assert(item && typeof item === 'object' && !Array.isArray(item), 'FOLLOW_UP_FEATURE_INVALID', 'Every follow-up Feature must be an object.');
      assert(typeof item.id === 'string' && item.id.length > 0, 'FOLLOW_UP_FEATURE_INVALID', 'Every follow-up Feature requires an ID.');
      const id = `${feature.id}/${item.id}`;
      const parentPaths = feature.allowedPaths;
      const childPaths = Array.isArray(item.allowedPaths) && item.allowedPaths.length ? item.allowedPaths : parentPaths;
      const withinParent = path => parentPaths.some(root => path === root || path.startsWith(`${root.replace(/\/$/, '')}/`));
      assert(childPaths.every(withinParent), 'FOLLOW_UP_PATH_OUTSIDE_PARENT', `Follow-up Feature ${id} exceeds its parent Feature paths.`);
      assert(item.projectId === undefined || item.projectId === input.state.projectId, 'FOLLOW_UP_PROJECT_OUTSIDE_PARENT', `Follow-up Feature ${id} belongs to a different project.`);
      const dependencies = [...new Set([feature.id, ...(item.dependsOn ?? []).map(dependency => `${feature.id}/${dependency}`)])];
      const taskProjection = taskFeatureProjection(defineNodeTaskContract({
        role: { id: 'implementation-engineer', description: 'Executes one explicitly proposed and path-bounded delivery follow-up.' },
        objective: `Complete approved follow-up ${item.id} for parent Feature ${feature.id}.`,
        instructions: ['Use the parent Feature result and current source as context.', 'Complete only the declared follow-up acceptance criteria.', 'Run focused verification and report exact changed files.'],
        inputs: [{ id: 'parent-feature', source: 'feature', path: 'dynamicParentId', required: true, description: 'The exact parent Feature that authorized this decomposition.' }],
        steps: item.steps?.length ? item.steps.map((step, index) => ({ id: step.id ?? `step-${index + 1}`, instruction: step.title ?? step.id ?? `Complete follow-up step ${index + 1}.` })) : [{ id: 'execute', instruction: `Execute follow-up ${item.id}.` }, { id: 'verify', instruction: `Verify follow-up ${item.id}.` }],
        constraints: ['Stay inside the parent Feature path authority.', 'Do not expand the follow-up beyond its declared acceptance criteria.'],
        acceptance: item.acceptance,
        evidenceRequirements: ['Cite the parent result, exact changed paths, and focused verification evidence.'],
      }));
      return {
        id,
        executionClass: 'agent-reasoning',
        kind: 'development-follow-up',
        ownerRole: item.ownerRole ?? feature.ownerRole,
        logicalRoot: `${feature.logicalRoot}:${item.id}`,
        laneId: item.laneId ?? feature.laneId,
        ...taskProjection,
        dependsOn: dependencies,
        allowedPaths: childPaths,
        forbiddenPaths: [...new Set([...feature.forbiddenPaths, ...(item.forbiddenPaths ?? [])])],
        symbols: item.symbols ?? [],
        contracts: item.contracts ?? [],
        generatedOutputs: item.generatedOutputs ?? [],
        conflictKeys: item.conflictKeys ?? [],
        gatePlan: feature.gatePlan,
        metadata: {
          stage: feature.metadata.stage,
          sourcePolicy: feature.metadata.sourcePolicy,
          dynamicParentId: feature.id,
          decompositionId: item.id,
          allowDynamicDecomposition: false,
        },
      };
    });
    return [...qualityRepairs, ...planned];
  },

  createGateDiagnosticReview(input) {
    return createQualityGateDiagnosticReview(input);
  },

  canClose(state) {
    const config = state.profile.config;
    if (state.features.some(feature => feature.metadata?.stage === 'plan-review') && !planReviewApproved(state)) return { ok: false, reason: 'plan-scope-review-not-approved' };
    if (state.features.some(feature => feature.metadata?.stage === 'plan-review') && !planApprovalSatisfied(state)) return { ok: false, reason: 'implementation-plan-user-approval-required' };
    if (state.metadata?.commandIntent && state.features.some(feature => feature.metadata?.stage === 'implementation') && !(
      state.features.some(feature => feature.metadata?.stage === 'plan-review') ? planApprovalSatisfied(state) : state.metadata?.approvedPlan
    )) return { ok: false, reason: 'implementation-plan-user-approval-required' };
    if (config.closeoutOnly && state.sourceDigest !== state.metadata?.qualityCloseout?.sourceDigest) return { ok: false, reason: 'quality-closeout-source-drift' };
    if (config.closeoutOnly && state.metadata?.qualityCloseout?.targetDigest !== state.metadata?.qualityTarget?.targetDigest) return { ok: false, reason: 'quality-closeout-evidence-mismatch' };
    if (config.requireFinalQualityReview && !hasCurrentCleanQualityReview(state)) {
      const qualityRoot = state.features.find(feature => feature.metadata?.qualityReview === true)?.metadata.qualityRoot ?? null;
      return { ok: false, reason: qualityReviewBudgetExhausted(state, qualityRoot) ? 'quality-review-limit-reached' : qualityReviewNoProgress(state, qualityRoot) ? 'quality-review-no-progress' : 'current-source-clean-quality-review-required' };
    }
    const missingGate = config.requiredFinalGates.find(id => !state.gates.some(gate => gate.id === id && gate.status === 'passed' && gate.forcedFresh));
    if (missingGate) return { ok: false, reason: `required-final-gate-missing:${missingGate}` };
    if (config.requireUserCodeReview && !approvalSatisfied(state, 'user-code-review')) return { ok: false, reason: 'user-code-review-required' };
    if (config.requireRoutineExitDecision && !approvalSatisfied(state, 'routine-version-exit')) return { ok: false, reason: 'routine-version-exit-decision-required' };
    return { ok: true };
  },

  project(state) {
    const byStage = Object.fromEntries(DELIVERY_STAGES.map(stage => [stage, state.features.filter(feature => feature.metadata.stage === stage).map(feature => ({ id: feature.id, state: feature.state }))]));
    return { profile: this.id, status: state.status, epoch: state.epoch, generation: state.generation, stages: byStage, openFindings: state.findings.filter(finding => finding.status !== 'resolved') };
  },
});

export const deliveryLifecycleProfile = createDeliveryLifecycleProfile();
