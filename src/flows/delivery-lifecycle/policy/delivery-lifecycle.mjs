import { assert } from '../../../common/errors.mjs';
import { defineNodeTaskContract, taskFeatureProjection } from '../../../common/task-contract.mjs';
import { approvalSatisfied } from '../../../flow-kit/primitives.mjs';
import { createQualityFollowUpFeatures, hasCurrentCleanQualityReview, validateQualityReviewPolicies } from '../../../flow-kit/profiles/quality-loop.mjs';

export const DELIVERY_STAGES = Object.freeze([
  'requirement-intake', 'canonical-requirement', 'version-planning', 'implementation',
  'scope-resolution', 'docs-closeout', 'quality', 'quality-repair', 'quality-recheck', 'user-code-review', 'delivery-receipt',
]);

const stageIndex = stage => DELIVERY_STAGES.indexOf(stage);

export const createDeliveryLifecycleProfile = (id = 'delivery-lifecycle') => Object.freeze({
  id,
  version: '1.0.0',

  validateConfig(config) {
    return {
      requireCanonicalDecision: config.requireCanonicalDecision !== false,
      requireUserCodeReview: config.requireUserCodeReview !== false,
      requiredFinalGates: [...new Set(config.requiredFinalGates ?? [])],
      requireFinalQualityReview: config.requireFinalQualityReview === true,
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

  canDispatch(feature, state) {
    const stage = feature.metadata.stage;
    const config = state.profile.config;
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
    if (!feature.metadata?.allowDynamicDecomposition || !Array.isArray(result?.followUpFeatures)) return qualityRepairs;
    const planned = result.followUpFeatures.map(item => {
      assert(item && typeof item === 'object' && !Array.isArray(item), 'FOLLOW_UP_FEATURE_INVALID', 'Every follow-up Feature must be an object.');
      assert(typeof item.id === 'string' && item.id.length > 0, 'FOLLOW_UP_FEATURE_INVALID', 'Every follow-up Feature requires an ID.');
      const id = `${feature.id}/${item.id}`;
      const parentPaths = feature.allowedPaths;
      const childPaths = Array.isArray(item.allowedPaths) && item.allowedPaths.length ? item.allowedPaths : parentPaths;
      const withinParent = path => parentPaths.some(root => path === root || path.startsWith(`${root.replace(/\/$/, '')}/`));
      assert(childPaths.every(withinParent), 'FOLLOW_UP_PATH_OUTSIDE_PARENT', `Follow-up Feature ${id} exceeds its parent Feature paths.`);
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

  canClose(state) {
    const config = state.profile.config;
    if (config.requireFinalQualityReview && !hasCurrentCleanQualityReview(state)) return { ok: false, reason: 'current-source-clean-quality-review-required' };
    const missingGate = config.requiredFinalGates.find(id => !state.gates.some(gate => gate.id === id && gate.status === 'passed' && gate.forcedFresh));
    if (missingGate) return { ok: false, reason: `required-final-gate-missing:${missingGate}` };
    if (config.requireUserCodeReview && !approvalSatisfied(state, 'user-code-review')) return { ok: false, reason: 'user-code-review-required' };
    return { ok: true };
  },

  project(state) {
    const byStage = Object.fromEntries(DELIVERY_STAGES.map(stage => [stage, state.features.filter(feature => feature.metadata.stage === stage).map(feature => ({ id: feature.id, state: feature.state }))]));
    return { profile: this.id, status: state.status, epoch: state.epoch, generation: state.generation, stages: byStage, openFindings: state.findings.filter(finding => finding.status !== 'resolved') };
  },
});

export const deliveryLifecycleProfile = createDeliveryLifecycleProfile();
