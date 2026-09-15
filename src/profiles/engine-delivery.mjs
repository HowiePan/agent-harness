import { assert } from '../errors.mjs';
import { approvalSatisfied } from '../workflows/primitives.mjs';
import { createQualityFollowUpFeatures, hasCurrentCleanQualityReview } from './quality-loop.mjs';

export const ENGINE_STAGES = Object.freeze([
  'requirement-intake', 'canonical-requirement', 'version-planning', 'implementation',
  'scope-resolution', 'docs-closeout', 'quality', 'quality-repair', 'quality-recheck', 'user-code-review', 'delivery-receipt',
]);

const stageIndex = stage => ENGINE_STAGES.indexOf(stage);

export const engineDeliveryProfile = Object.freeze({
  id: 'engine-delivery',
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
    for (const feature of state.features) {
      const stage = feature.metadata.stage;
      assert(ENGINE_STAGES.includes(stage), 'ENGINE_STAGE_INVALID', `Engine Feature ${feature.id} has an invalid stage: ${stage}`);
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
      return {
        id,
        kind: 'development-follow-up',
        ownerRole: item.ownerRole ?? feature.ownerRole,
        logicalRoot: `${feature.logicalRoot}:${item.id}`,
        laneId: item.laneId ?? feature.laneId,
        acceptance: item.acceptance,
        steps: item.steps ?? [],
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
    const byStage = Object.fromEntries(ENGINE_STAGES.map(stage => [stage, state.features.filter(feature => feature.metadata.stage === stage).map(feature => ({ id: feature.id, state: feature.state }))]));
    return { profile: this.id, status: state.status, epoch: state.epoch, generation: state.generation, stages: byStage, openFindings: state.findings.filter(finding => finding.status !== 'resolved') };
  },
});
