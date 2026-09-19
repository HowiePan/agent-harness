import { assert } from '../../../common/errors.mjs';
import { validateWorkGraph } from '../../../kernel/work-graph.mjs';

const select = (value, path) => String(path ?? '').split('.').filter(Boolean).reduce((current, segment) => current?.[segment], value);

export const composableWorkflowProfile = Object.freeze({
  id: 'composable-workflow', version: '1.0.0',
  validateConfig(config) {
    const branches = structuredClone(config.branches ?? []);
    assert(Array.isArray(branches) && branches.length <= 32, 'WORKFLOW_BRANCH_BUDGET', 'Workflow accepts at most 32 continuation rules.');
    for (const branch of branches) {
      assert(branch.nodeId && branch.portId && branch.schemaId && branch.path && Array.isArray(branch.features) && branch.features.length > 0 && branch.features.length <= 20, 'WORKFLOW_BRANCH_INVALID', 'Continuation rule requires a node, typed output selector, and bounded Features.');
      assert(branch.features.every(feature => feature.executionClass === 'agent-reasoning'), 'WORKFLOW_BRANCH_CLASS_INVALID', 'Continuation may only append Agent Features.');
    }
    return { requiredFinalGates: [...new Set(config.requiredFinalGates ?? [])], requiredDecisions: [...new Set(config.requiredDecisions ?? [])], branches };
  },
  validateRun(state) { return state; },
  canDispatch() { return { ok: true }; },
  validateResult({ state, feature, result }) {
    for (const [portId, schemaId] of Object.entries(feature.metadata?.outputPorts ?? {})) if (result.outputs?.[portId]?.schemaId !== schemaId) return { ok: false, reason: `missing-typed-output:${portId}` };
    const checks = feature.metadata?.outputChecks ?? [];
    assert(Array.isArray(checks) && checks.length <= 16, 'WORKFLOW_OUTPUT_CHECK_INVALID', 'Node accepts at most 16 output checks.');
    for (const check of checks) {
      assert(check?.portId && check.path && ['equals', 'non-empty', 'output-path'].includes(check.operator), 'WORKFLOW_OUTPUT_CHECK_INVALID', 'Output check requires a port, path, and supported operator.');
      const value = select(result.outputs?.[check.portId]?.value, check.path);
      const valid = check.operator === 'equals' ? value === check.value
        : check.operator === 'output-path' ? value === feature.metadata?.outputPath
        : value !== undefined && value !== null && value !== '' && (!Array.isArray(value) || value.length > 0);
      if (!valid) return { ok: false, reason: `output-check-failed:${check.portId}.${check.path}` };
    }
    if (feature.metadata?.expectedHit !== undefined && result.outputs?.match?.value?.hit !== feature.metadata.expectedHit) return { ok: false, reason: 'memory-hit-mismatch' };
    const fingerprint = result.outputs?.answer?.value?.claimFingerprint;
    if (fingerprint && (state.metadata?.memorySnapshot ?? []).some(item => item.kind === 'negative' && item.topic === fingerprint && item.validity === 'current')) return { ok: false, reason: 'rejected-answer-repeated' };
    const nodeId = feature.metadata?.workflow?.nodeId;
    const rules = state.profile.config.branches.filter(branch => branch.nodeId === nodeId);
    for (const rule of rules) {
      const output = result.outputs?.[rule.portId];
      if (!output || output.schemaId !== rule.schemaId) return { ok: false, reason: `missing-typed-output:${rule.portId}` };
    }
    return { ok: true };
  },
  createFollowUpFeatures({ state, feature, result }) {
    if (result.status !== 'completed') return [];
    const nodeId = feature.metadata?.workflow?.nodeId;
    const rules = state.profile.config.branches.filter(branch => branch.nodeId === nodeId);
    const matching = rules.filter(rule => select(result.outputs[rule.portId].value, rule.path) === rule.equals);
    if (rules.length) assert(matching.length > 0, 'WORKFLOW_BRANCH_UNMATCHED', `No continuation rule matched ${nodeId}.`);
    assert(matching.length <= 1, 'WORKFLOW_BRANCH_AMBIGUOUS', `Multiple continuation rules matched ${nodeId}.`);
    const appended = matching.flatMap(rule => rule.features.map(candidate => ({ ...structuredClone(candidate), dependsOn: [...new Set([feature.id, ...(candidate.dependsOn ?? [])])] })));
    assert(state.features.length + appended.length <= 100, 'WORKFLOW_FEATURE_BUDGET', 'Workflow continuation exceeds 100 Features.');
    if (appended.length) validateWorkGraph([...state.features, ...appended]);
    return appended;
  },
  canClose(state) {
    const missingGate = state.profile.config.requiredFinalGates.find(id => !state.gates.some(gate => gate.id === id && gate.status === 'passed' && gate.forcedFresh));
    if (missingGate) return { ok: false, reason: `required-final-gate-missing:${missingGate}` };
    const missingDecision = state.profile.config.requiredDecisions.find(id => !state.decisions.some(decision => decision.id === id && decision.decision === 'approved'));
    if (missingDecision) return { ok: false, reason: `required-decision-missing:${missingDecision}` };
    return { ok: true };
  },
  project(state) { return { profile: this.id, workflow: state.metadata?.workflow ?? null, status: state.status, features: state.features.map(feature => ({ id: feature.id, state: feature.state })) }; },
});
