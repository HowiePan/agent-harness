import { assert } from '../common/errors.mjs';
import { digestJson } from '../common/canonical.mjs';

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
