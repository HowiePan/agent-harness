import { assert } from '../errors.mjs';
import { approvalSatisfied } from '../workflows/primitives.mjs';

export const ENGINE_STAGES = Object.freeze([
  'requirement-intake', 'canonical-requirement', 'version-planning', 'implementation',
  'scope-resolution', 'quality', 'docs-closeout', 'user-code-review',
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

  canClose(state) {
    const config = state.profile.config;
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
