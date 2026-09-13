export const featureDeliveryProfile = Object.freeze({
  id: 'feature-delivery',
  version: '1.0.0',
  validateConfig(config) { return { requiredFinalGates: [...new Set(config.requiredFinalGates ?? [])], requiredDecisions: [...new Set(config.requiredDecisions ?? [])] }; },
  validateRun(state) { return state; },
  canDispatch() { return { ok: true }; },
  canClose(state) {
    const missingGate = state.profile.config.requiredFinalGates.find(id => !state.gates.some(gate => gate.id === id && gate.status === 'passed' && gate.forcedFresh));
    if (missingGate) return { ok: false, reason: `required-final-gate-missing:${missingGate}` };
    const missingDecision = state.profile.config.requiredDecisions.find(id => !state.decisions.some(decision => decision.id === id && decision.decision === 'approved'));
    if (missingDecision) return { ok: false, reason: `required-decision-missing:${missingDecision}` };
    return { ok: true };
  },
  project(state) { return { profile: this.id, status: state.status, epoch: state.epoch, generation: state.generation, features: state.features.map(feature => ({ id: feature.id, state: feature.state })) }; },
});
