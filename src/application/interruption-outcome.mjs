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
  const assessment=state?.decisions.findLast(d=>d.kind==='execution-intervention-assessment'&&d.featureId===feature?.id);
  const diagnosis = { phase: 'terminal-control-review', policy: decision.policy,
    observedReason: result.reason ?? result.execution?.reason ?? result.status,
    attempted: [...input.history.map(item => ({ action: item.action, id: item.id, evidenceRefs: item.evidenceRefs })),
      ...(state?.submissions??[]).filter(s=>s.featureId===feature?.id).map(s=>({action:s.changedFiles?.length?'implementation':'execution-observation',
        id:s.submissionId,changedFiles:s.changedFiles??[],status:s.result.status,evidenceRefs:s.evidenceRefs})),
      ...(state?.metadata?.dependencyRepairs??[]).filter(r=>r.sourceFeatureId===feature?.id).map(r=>({action:'dependency-return',
        id:r.id,status:r.status,ownerFeatureId:r.ownerFeatureId,evidenceRefs:[r.assessmentRef]}))],
    remainingCapability: assessment?.disposition==='correction-required'?'Diagnostic validation remains unresolved; business repair is not represented as attempted.':
      assessment?.disposition==='blocked'?'The current source-bound assessment retains the listed prerequisites.':'No verified next action is scheduled in the current state.',
    validationIssues:assessment?.assessment.issues??[],unresolvedBoundaries:assessment?.assessment.boundaries??[],
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
  const recovery=error.details?.actionRecovery;
  const decision = decideInterruption({ problem: { logicalRoot: plan?.logicalTaskKey ?? null,
    sourceDigest: recovery?.sourceDigest ?? plan?.run?.sourceDigest ?? null, contractDigest: plan?.planDigest ?? null,
    summary: error?.message ?? String(error) }, facts: { identityTrusted: ['identity','integrity'].includes(fault.category)
      ||recovery?.reason==='trusted-state-unresolved'?false:undefined,
    userStopped: error?.code === 'OPERATOR_EXECUTION_STOPPED'||recovery?.reason==='user-stop',
    authorizationRequired:fault.category==='authorization'||['authorization','current-command-unavailable'].includes(recovery?.reason),
    stagnant:recovery?.reason==='no-progress',
    budgetExhausted:fault.category==='recovery-budget'||recovery?.reason==='recovery-budget' }, capabilities: [] });
  return { ...decision, coordination: coordinationRecoveryDirective({ interruption: decision, planDigest: plan?.planDigest, runId: plan?.run?.runId }),
    diagnosis: { phase, fault, observedCode: error?.code ?? 'UNKNOWN_ERROR',
    isolatedAction: 'Dependent writes and unverified submissions remain stopped.',
    attempted: recovery?[{action:'inspect',inspected:recovery.inspected,evidenceRef:recovery.evidenceRef??null,
      outcome:recovery.action,reason:recovery.reason}]:[],
    ...(recovery?{recovery}:{}),
    missingCapability: recovery?.reason??'Failure has not yet received a verified recovery inspection.' } };
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
