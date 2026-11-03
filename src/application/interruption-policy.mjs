import { digestJson } from '../common/canonical.mjs';

import { INTERRUPTION_POLICY, MAX_INTERVENTIONS_PER_ROOT } from '../common/interruption-contract.mjs';
export { INTERRUPTION_POLICY, MAX_INTERVENTIONS_PER_ROOT, featureContractDigest } from '../common/interruption-contract.mjs';

/** Facts and capabilities come from the Host, never from the worker's labels. */
export const decideInterruption = ({ problem, facts = {}, capabilities = [], history = [] }) => {
  const fingerprint = digestJson({ root: problem.logicalRoot ?? null, source: problem.sourceDigest ?? null,
    contract: problem.contractDigest ?? null });
  const used = history.filter(item => item.logicalRoot === problem.logicalRoot);
  const limit = Number.isSafeInteger(facts.recoveryLimit) ? Math.max(0, Math.min(MAX_INTERVENTIONS_PER_ROOT, facts.recoveryLimit)) : MAX_INTERVENTIONS_PER_ROOT;
  const body = { policy: INTERRUPTION_POLICY, boundary: 'action', fingerprint,
    problem: structuredClone(problem), attempts: used.map(item => ({ id: item.id, action: item.action ?? null,
      sourceDigest: item.sourceDigest ?? null, evidenceRefs: item.evidenceRefs ?? [] })),
    evidenceRefs: [...new Set(facts.evidenceRefs ?? [])],
    budget: { used: used.length, limit, executionRemaining: facts.executionRemaining ?? null } };
  const decision = (action, category, reason, requiredDecision = null, capabilityId = null) => {
    const value = { ...body, action, category, reason, requiredDecision, capabilityId,
      boundary: action === 'stop' ? 'workflow' : 'action' };
    return { ...value, decisionDigest: digestJson(value) };
  };
  if (facts.userStopped) return decision('stop', 'user-stop', 'The user explicitly stopped this work.', 'resume-or-change-goal');
  if (facts.budgetExhausted) return decision('stop', 'budget', 'The next required execution has no approved allowance.', 'exact-budget-or-strategy-decision');
  // A known hard boundary stops dependent writes. Diagnostics may still run if
  // they have independent, verified read-only authority and a finite allowance.
  const hard = facts.authorizationRequired ? 'authorization' : facts.contractChangeVerified ? 'contract'
    : facts.integrityRisk ? 'integrity' : facts.identityTrusted === false ? 'identity' : null;
  const admissible = capabilities.filter(item => item.available === true && item.authorized === true
    && item.evidenceBound === true && (!hard || item.readOnly === true));
  if (hard) {
    const diagnostic = admissible.find(item => item.operation === 'diagnose');
    if (diagnostic && used.length < limit && !used.some(item => item.fingerprint === fingerprint)) {
      return decision('diagnose', hard, 'Isolate the dependent action and verify the boundary without source writes.', null, diagnostic.id);
    }
    return decision('stop', hard, 'The required action crosses a verified boundary and no admissible diagnostic remains.',
      hard === 'contract' ? 'approve-minimal-contract-delta' : `resolve-${hard}-boundary`);
  }
  const direct = admissible.find(item => ['repair', 'recover', 'continue'].includes(item.operation));
  if (direct) return decision(direct.operation, 'in-scope', 'A verified, bounded handler can solve this within existing authority.', null, direct.id);
  if (facts.waitSignalVerified && facts.waitDeadlineValid) {
    const waiting = admissible.find(item => item.operation === 'wait');
    if (waiting) return decision('wait', 'external-wait', 'Wait for the exact bounded external signal; independent work may continue.', null, waiting.id);
  }
  if (used.length >= limit) return decision('stop', 'recovery-budget',
    'The finite recovery allowance for this logical root is exhausted.', 'bounded-recovery-or-contract-decision');
  const clarification = admissible.find(item => item.operation === 'diagnose' && item.readOnly === true);
  if (clarification && facts.diagnosticCorrectionVerified && problem.correctionOf && problem.assessmentId) {
    return decision('diagnose', 'recommendation-correction', 'Clarify the exact rejected recommendation under the existing finite allowance.', null, clarification.id);
  }
  if (used.some(item => item.fingerprint === fingerprint)) return decision('stop', 'no-progress',
    'This source and contract already had a diagnostic; repeating it has no new basis.', 'resolve-recorded-diagnostic');
  const review = admissible.find(item => item.operation === 'diagnose');
  if (review) return decision('diagnose', 'unresolved', 'Collect evidence and review remaining work before deciding to stop or amend.', null, review.id);
  return decision('stop', 'capability', 'No authorized, evidence-bound handler or diagnostic is available.', 'restore-required-capability');
};

export const interventionHistory = state => state.metadata?.interruptionLedger ?? [];
