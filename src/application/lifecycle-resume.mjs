import { assert } from '../common/errors.mjs';
import { submissionAttempt } from '../kernel/attempt-budget.mjs';
import { isInterruptedImplementationSubmission } from './lifecycle-interruption.mjs';
import { ACCEPTANCE_CONTINUATION_POLICY, hasNewAcceptanceCheckpoint } from './implementation-continuation.mjs';
import { hasTargetImplementationProgress, isIncompleteImplementationResult } from './implementation-handoff.mjs';

// A capacity handoff may preserve local progress while a later protected action
// still awaits an external receipt. Reuse the committed Dispatch's proof scope;
// neither the blocker label nor a claimed checkpoint grants continuation.
const isCommittedProgressHandoff = (state, feature, submission) => {
  if (feature?.metadata?.stage !== 'implementation' || submission?.featureId !== feature.id
    || !['context-limit', 'context-capacity'].includes(submission.result?.blocker?.kind)
    || !['implementation-incomplete', 'external-prerequisite-and-incomplete-implementation'].includes(submission.result?.failureClass)
    || submission.supersededAt || !submission.evidenceRefs?.length
    || submission.outputSourceDigest !== state.sourceDigest) return false;
  const attempt = submissionAttempt(state, feature, submission);
  const dispatch = state.dispatches?.find(item => item.dispatchId === submission.dispatchId);
  const context = dispatch?.execution?.implementationContinuation;
  return attempt?.budgetKind === 'progress'
    && attempt.records?.some(item => item.submissionId === submission.submissionId && item.dispatchId === submission.dispatchId)
    && dispatch?.status === 'committed' && context?.policy === ACCEPTANCE_CONTINUATION_POLICY
    && (hasNewAcceptanceCheckpoint(state, feature, submission, context)
      || hasTargetImplementationProgress(state, feature, submission, context));
};

export const isResumableImplementationSubmission = (state, feature, submission) =>
  (isIncompleteImplementationResult(submission?.result) && submission.evidenceRefs?.length > 0)
  || submission?.result?.status === 'blocked'
  && (submission.result.blocker?.kind === 'in-scope-fix-blocked'
    || isCommittedProgressHandoff(state, feature, submission)
    || (feature.blocker?.kind === 'attempt-budget-carryover'
      && state.metadata?.attemptCarryover?.submissionIds.includes(submission.submissionId)
      && state.metadata?.approvedPlan?.typedPlan?.amendment));

// The public implementation action owns continuation. Never choose a Run by
// source digest: legitimate source progress changes it between invocations.
export const selectImplementationContinuationRun = (states, intent) => {
  assert(intent?.action === 'implement', 'LIFECYCLE_IMPLEMENT_INTENT_REQUIRED', 'Implementation continuation requires an implement intent.');
  const candidates = states.filter(state => {
    const prior = state.metadata?.commandIntent;
    return !['closed', 'incomplete', 'failed', 'superseded'].includes(state.status) && prior?.action === 'implement'
      && prior.target === intent.target && prior.preset === intent.preset
      && prior.workflowId === intent.workflowId && prior.profileId === intent.profileId;
  });
  assert(candidates.length <= 1, 'LIFECYCLE_IMPLEMENT_RUN_AMBIGUOUS', 'More than one unfinished implementation Run matches this command.');
  return candidates[0] ?? null;
};

export const selectQualityContinuationRun = (states, intent) => {
  assert(intent?.action === 'quality', 'LIFECYCLE_QUALITY_INTENT_REQUIRED', 'Quality continuation requires a quality intent.');
  const candidates = states.filter(state => {
    const prior = state.metadata?.commandIntent;
    return !['closed', 'incomplete', 'failed', 'superseded'].includes(state.status) && prior?.action === 'quality'
      && prior.target === intent.target && prior.preset === intent.preset
      && prior.workflowId === intent.workflowId && prior.profileId === intent.profileId;
  });
  assert(candidates.length <= 1, 'LIFECYCLE_QUALITY_RUN_AMBIGUOUS', 'More than one unfinished quality Run matches this command.');
  return candidates[0] ?? null;
};

// A continuation may retry an unfinished implementation, but cannot turn an
// approval, exhausted budget, or unrelated blocked stage into executable work.
const assertResumableFeature = (state, feature) => {
  assert(['implementation', 'quality', 'quality-repair', 'quality-recheck', 'quality-closeout'].includes(feature.metadata?.stage),
    'LIFECYCLE_RESUME_BLOCKED_STAGE', 'The blocked Feature is not a resumable implementation or quality stage.');
  const submission = [...state.submissions].reverse().find(item => item.featureId === feature.id);
  assert(submission?.result?.failureClass !== 'implementation-sizing-review', 'DELIVERY_BATCH_SIZING_REVIEW_REQUIRED',
    'Repeated incomplete handoffs require a bounded batch sizing/strategy review before more implementation dispatches.');
  const inScopeFix = isResumableImplementationSubmission(state, feature, submission);
  const providerFailure = submission?.result?.status === 'failed' && submission.result.failureClass === 'runtime-provider'
    && submission.result.blocker?.kind === 'runtime-provider';
  assert((feature.metadata?.stage === 'implementation' && inScopeFix) || providerFailure
    || isInterruptedImplementationSubmission(state, feature, submission),
    'LIFECYCLE_RESUME_BLOCKER_REQUIRES_REVIEW', 'The blocked Feature is not an in-scope fix or a retryable provider failure.');
  const attempt = submissionAttempt(state, feature, submission);
  assert(attempt && !attempt.exhausted, 'LIFECYCLE_RESUME_BUDGET_EXHAUSTED', 'The blocked Feature has exhausted its attempt budget.');
  return feature.id;
};

export const selectBlockedResumeFeature = state => {
  const blocked = state.features.filter(feature => feature.state === 'blocked');
  if (!blocked.length) return null;
  if (blocked.length === 1) return assertResumableFeature(state, blocked[0]);
  const eligible = blocked.filter(feature => {
    if (!(feature.dependsOn ?? []).every(id => state.features.some(item => item.id === id && item.state === 'completed'))) return false;
    try { assertResumableFeature(state, feature); return true; } catch { return false; }
  });
  // The approved graph order is stable; reopen one executable frontier only.
  // Other scope, external, approval and exhausted blockers remain untouched.
  assert(eligible.length > 0, 'LIFECYCLE_RESUME_BLOCKER_REQUIRES_REVIEW',
    'No blocked Feature has both completed dependencies and an authorized retry with remaining budget.');
  return eligible[0].id;
};
