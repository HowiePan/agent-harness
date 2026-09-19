import { assert } from '../../common/errors.mjs';

export const hardRecoveryCapability = Symbol('agent-harness-hard-recovery');

export const assertHardRecoveryDecision = (state, decisionId, verification, now = () => new Date().toISOString()) => {
  assert(decisionId, 'RECOVERY_AUTHORITY_DECISION_REQUIRED', 'The legacy hard-recovery compatibility path requires an approved Authority Decision.');
  const decision = state.decisions.find(item => item.id === decisionId);
  assert(decision, 'RECOVERY_AUTHORITY_DECISION_REQUIRED', 'The legacy hard-recovery Authority Decision is not recorded in the current run.');
  assert(decision.actor && decision.decision === 'approved' && decision.action === 'live-hard-recovery', 'RECOVERY_AUTHORITY_DECISION_REJECTED', 'The Authority Decision does not approve live hard recovery.');
  assert(typeof decision.expiresAt === 'string' && !Number.isNaN(Date.parse(decision.expiresAt)) && Date.parse(decision.expiresAt) > Date.parse(now()), 'RECOVERY_AUTHORITY_DECISION_EXPIRED', 'The hard-recovery Authority Decision is expired or has no valid expiry.');
  const context = decision.context ?? {};
  assert(context.projectId === state.projectId && context.runId === state.runId && context.verificationRef === verification.verificationRef && context.targetEpoch === state.epoch + 1 && context.expectedRevision === state.revision, 'RECOVERY_AUTHORITY_DECISION_CONTEXT_MISMATCH', 'The Authority Decision does not match the run, revision, verified Capsule, and target epoch.');
  return decision;
};
