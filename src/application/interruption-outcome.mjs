import { decideInterruption, interventionHistory } from './interruption-policy.mjs';
import { interruptionContext } from './interruption-review.mjs';
import { isExecutionComplete } from '../kernel/intervention.mjs';
import { coordinationRecoveryDirective } from './coordination-recovery.mjs';
import {executionFault} from './execution-fault.mjs';

// These are trusted control-plane exit families, not worker failure labels.
export const INTERRUPTION_EXIT_COVERAGE = Object.freeze({
  preflight: 'capability-and-identity-diagnosis', dispatch: 'read-only-review-or-formal-recovery',
  result: 'bounded-repair-or-source-bound-review', verification: 'real-check-repair',
  resume: 'same-policy-and-ledger', gates: 'profile-diagnostic-and-fresh-gates',
  transport: 'isolate-effect-and-recover-trusted-host', closure: 'exact-approval-or-budget-boundary',
  coordinationLimit: 'finite-coordination-budget', unknown: 'restricted-diagnosis-before-escalation',
});
const approvalReasons = new Set(['implementation-plan-user-approval-required', 'canonical-requirement-decision-required',
  'routine-version-exit-decision-required', 'user-code-review-required']);
const budgetReasons = new Set(['quality-review-limit-reached', 'visible-coordinator-round-limit']);

/** All public lifecycle exits use one evidence-bearing decision envelope. */
export const sealInterruptionOutcome = async (context, api, plan, result) => {
  if (result?.status !== 'attention-required' && !['idle', 'all-remaining-blocked', 'failed-budget'].includes(result?.status)) return result;
  const state = result.state;
  const feature = state?.features.find(item => ['blocked', 'failed-budget'].includes(item.state) && item.kind !== 'execution-diagnostic');
  const input = feature ? interruptionContext(state, feature) : { problem: { logicalRoot: plan?.logicalTaskKey ?? null,
    sourceDigest: state?.sourceDigest ?? plan?.run?.sourceDigest ?? null, contractDigest: plan?.planDigest ?? null,
    summary: result.reason ?? result.status }, facts: { identityTrusted: Boolean(state), evidenceRefs: [] }, history: interventionHistory(state ?? {}) };
  const decision = decideInterruption({ ...input, capabilities: [], facts: { ...input.facts,
    userStopped: state?.metadata?.operatorStop?.requested === true,
    authorizationRequired: approvalReasons.has(result.reason) || Boolean(state?.features.every(isExecutionComplete)
      && state.profile.config.requiredDecisions?.some(id => !state.decisions.some(item => item.id === id && item.decision === 'approved'))),
    budgetExhausted: input.facts.budgetExhausted || budgetReasons.has(result.reason) } });
  const diagnosis = { phase: 'terminal-control-review', policy: decision.policy,
    observedReason: result.reason ?? result.execution?.reason ?? result.status,
    attempted: input.history.map(item => ({ action: item.action, id: item.id, evidenceRefs: item.evidenceRefs })),
    remainingCapability: 'No admissible scheduled repair or source-bound review remains at this exit.',
    preserved: { sourceDigest: state?.sourceDigest ?? null, featureId: feature?.id ?? null,
      submissionIds: state?.submissions.filter(item => item.featureId === feature?.id).map(item => item.submissionId) ?? [] },
    requiredDecision: decision.requiredDecision };
  let current = state;
  let evidenceRef = null;
  if (state && !['closed', 'incomplete', 'failed', 'superseded'].includes(state.status)) {
    const recorded = await api.recordInterruptionDecision(state.projectId, state.runId,
      { ...decision }, `interruption-outcome-${decision.decisionDigest}`);
    current = recorded.state;
    evidenceRef = recorded.result.evidenceRef ?? recorded.result.decision?.evidenceRef ?? current.decisions.at(-1)?.evidenceRef ?? null;
  }
  return { ...result, status: 'attention-required', ...(current ? { state: current } : {}),
    coordination: coordinationRecoveryDirective({ status: 'attention-required', interruption: decision, planDigest: plan?.planDigest, runId: state?.runId }),
    interruption: { ...decision, evidenceRef, diagnosis, exitCoverage: INTERRUPTION_EXIT_COVERAGE } };
};

export const describeInterruptionError = (error, { phase = 'transport', plan = null } = {}) => {
  const fault=executionFault(error,{phase});
  const decision = decideInterruption({ problem: { logicalRoot: plan?.logicalTaskKey ?? null,
    sourceDigest: plan?.run?.sourceDigest ?? null, contractDigest: plan?.planDigest ?? null,
    summary: error?.message ?? String(error) }, facts: { identityTrusted: ['identity','integrity'].includes(fault.category)?false:undefined,
    userStopped: error?.code === 'OPERATOR_EXECUTION_STOPPED', authorizationRequired:fault.category==='authorization',
    budgetExhausted:fault.category==='recovery-budget' }, capabilities: [] });
  return { ...decision, coordination: coordinationRecoveryDirective({ interruption: decision, planDigest: plan?.planDigest, runId: plan?.run?.runId }),
    diagnosis: { phase, fault, observedCode: error?.code ?? 'UNKNOWN_ERROR',
    isolatedAction: 'Dependent writes and unverified submissions remain stopped.',
    attempted: ['Inspect the trusted exception and available execution identity; do not reinterpret worker labels as authority.'],
    missingCapability: 'No verified in-process repair may replace missing Host, source or Authority evidence.' } };
};

export const describeReadinessInterruption = report => {
  if (report.executionReady) return null;
  const decision = decideInterruption({ problem: { logicalRoot: report.lineageResolution?.logicalTaskKey ?? null,
    sourceDigest: null, contractDigest: report.planDigest ?? null, summary: 'Execution readiness could not prove the required capabilities.' },
  facts: { identityTrusted: report.release?.active === true }, capabilities: [] });
  return { ...decision, diagnosis: { phase: 'preflight', reportDigest: report.reportDigest,
    attempted: report.checks.filter(check => !check.ready).slice(0, 12).map(check => ({ id: check.id,
      issues: check.issues.slice(0, 3).map(issue => ({ code: String(issue.code).slice(0, 128) })) })),
    requiredAction: 'Restore the verified missing capability or authority before creating a Run; no Agent CLI or untrusted fallback.' } };
};
