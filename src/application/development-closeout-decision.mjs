import { assert } from '../common/errors.mjs';
import { digestJson } from '../common/canonical.mjs';
import { planApprovalSnapshot, planApprovalSatisfied } from '../flows/delivery-lifecycle/plan-approval.mjs';

/** Source-linked approval of a reviewed Plan binds the exact Run and Markdown bytes. */
export const assertDevelopmentPlanDecisionScope = ({ state, decision, projectId, expectedRevision, commandId, profile, workspaceMatch }) => {
  const snapshot = planApprovalSnapshot(state);
  const recorded = state.decisions?.find(item => item.id === 'implementation-plan-approved');
  const awaiting = state.status === 'closure-blocked' && !recorded
    && profile.canClose(state).reason === 'implementation-plan-user-approval-required';
  const continuing = ['closure-blocked', 'ready-to-close', 'closed'].includes(state.status)
    && state.features.every(feature => feature.state === 'completed')
    && !state.leases?.some(lease => lease.status === 'active')
    && recorded?.digest === digestJson(decision) && planApprovalSatisfied(state)
    && profile.canClose(state).ok === true;
  assert(commandId && workspaceMatch && state.projectId === projectId && state.revision === expectedRevision
    && snapshot?.reviewApproved && (awaiting || continuing)
    && decision?.id === 'implementation-plan-approved' && decision.actor === 'user'
    && decision.decision === 'approved' && decision.projectId === snapshot.projectId
    && decision.runId === snapshot.runId && decision.planDigest === snapshot.planDigest
    && decision.artifactDigest === snapshot.artifactDigest,
  'DEVELOPMENT_PLAN_DECISION_SCOPE_MISMATCH', 'Source-linked approval must bind the exact independently reviewed Plan Run and Markdown.');
  return { recorded: Boolean(recorded) };
};

/** Limit source-linked CLI decisions to a ready, exact closeout Run. */
export const assertDevelopmentCloseoutDecisionScope = ({ state, decision, projectId, expectedRevision, commandId, profile, currentSourceDigest, workspaceMatch }) => {
  const recorded = state.decisions?.find(item => item.id === 'routine-version-exit');
  const awaiting = state.status === 'closure-blocked' && !recorded
    && profile.canClose(state).reason === 'routine-version-exit-decision-required';
  const continuing = ['ready-to-close', 'closed'].includes(state.status)
    && recorded?.digest === digestJson(decision) && profile.canClose(state).ok === true;
  assert(commandId && workspaceMatch && state.projectId === projectId && state.profile?.config?.closeoutOnly === true
    && (awaiting || continuing) && state.sourceDigest === state.metadata?.qualityCloseout?.sourceDigest
    && state.sourceDigest === currentSourceDigest
    && state.revision === expectedRevision && decision?.id === 'routine-version-exit'
    && decision.decision === 'approved' && decision.runId === state.runId,
  'DEVELOPMENT_CLOSEOUT_DECISION_SCOPE_MISMATCH', 'Source-linked decision must approve the exact ready closeout Run.');
  return { recorded: Boolean(recorded) };
};
