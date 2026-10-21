import { submissionAttempt } from '../kernel/attempt-budget.mjs';

export const HANDOFF_CORRECTION_POLICY = 'bounded-implementation-handoff/1';
export const correctionReasonPrefix = (commandId, featureId) => `implementation-handoff-correction:${commandId}:${featureId}:`;

const completed = item => item.status === 'completed' && item.evidence?.length > 0;

/** A compiled target step advances implementation, never aggregate acceptance. */
export const hasTargetImplementationProgress = (state, feature, submission, context) => {
  if (context?.correctionPolicy?.id !== HANDOFF_CORRECTION_POLICY || !submission.evidenceRefs?.length
    || !submission.inputSourceDigest || submission.inputSourceDigest === submission.outputSourceDigest) return false;
  const checkpoints = submission.result?.checkpoints ?? [];
  const prior = state.submissions.filter(item => item.featureId === feature.id && item.submissionId !== submission.submissionId);
  if (prior.some(item => [item.inputSourceDigest, item.outputSourceDigest].includes(submission.outputSourceDigest))) return false;
  return (context.implementationSteps ?? []).some(step => submission.changedFiles?.includes(step.targetPath)
    && checkpoints.some(item => item.id === step.id && completed(item))
    && checkpoints.some(item => item.id === `${step.id}:focused-verification` && completed(item)));
};

/** Correct an unproductive project-owned handoff once per explicit invocation. */
export const shouldCorrectImplementationHandoff = ({ state, feature, submission, commandId }) => {
  if (!commandId || feature?.metadata?.stage !== 'implementation' || feature.state !== 'blocked'
    || submission?.featureId !== feature.id || !submission.evidenceRefs?.length
    || submission.result?.status !== 'blocked' || submission.result.failureClass !== 'implementation-incomplete'
    || submission.result.blocker?.kind !== 'implementation') return false;
  const context = state.dispatches?.find(item => item.dispatchId === submission.dispatchId)?.execution?.implementationContinuation;
  if (context?.correctionPolicy?.id !== HANDOFF_CORRECTION_POLICY) return false;
  const attempt = submissionAttempt(state, feature, submission);
  if (!attempt || attempt.exhausted) return false;
  if (submission.inputSourceDigest !== submission.outputSourceDigest && state.submissions.some(item =>
    item.featureId === feature.id && item.submissionId !== submission.submissionId
    && [item.inputSourceDigest, item.outputSourceDigest].includes(submission.outputSourceDigest))) return false;
  const prefix = correctionReasonPrefix(commandId, feature.id);
  return !state.events?.some(item => item.type === 'feature.reopened' && item.featureId === feature.id
    && item.reason?.startsWith(prefix));
};

export const implementationHandoffCorrectionReason = (commandId, feature, context) => {
  const next = context.nextImplementationStep;
  return `${correctionReasonPrefix(commandId, feature.id)} The previous result only restated unfinished project-owned work; it identified no concrete authority, scope, environment or external prerequisite. Continue implementing, rather than rerunning the missing-certificate check and returning the same gap list. ${next ? `First implement and wire the approved target ${next.targetPath}, implementing any missing owner dependencies before its thin consumer. The target is a starting candidate, not an override of approved dependency order; report the actual implemented step id and its :focused-verification checkpoint with real evidence.` : 'Select the first unresolved approved obligation and implement its final target and consumers.'} Missing project-owned code or certificates are the work to perform, not an external blocker. If an actual prerequisite prevents that action, report its exact identity, attempted action and observed failure in the existing blocker/evidence fields. This is one bounded correction within the same Feature and existing attempt budget, not completion, added authority or a budget reset.`;
};
