import { assert } from '../common/errors.mjs';

// The public implementation action owns continuation. Never choose a Run by
// source digest: legitimate source progress changes it between invocations.
export const selectImplementationContinuationRun = (states, intent) => {
  assert(intent?.action === 'implement', 'LIFECYCLE_IMPLEMENT_INTENT_REQUIRED', 'Implementation continuation requires an implement intent.');
  const candidates = states.filter(state => {
    const prior = state.metadata?.commandIntent;
    return !['closed', 'superseded'].includes(state.status) && prior?.action === 'implement'
      && prior.target === intent.target && prior.preset === intent.preset
      && prior.workflowId === intent.workflowId && prior.profileId === intent.profileId;
  });
  assert(candidates.length <= 1, 'LIFECYCLE_IMPLEMENT_RUN_AMBIGUOUS', 'More than one unfinished implementation Run matches this command.');
  return candidates[0] ?? null;
};

// A continuation may retry an unfinished implementation, but cannot turn an
// approval, exhausted budget, or unrelated blocked stage into executable work.
export const selectBlockedResumeFeature = state => {
  const blocked = state.features.filter(feature => feature.state === 'blocked');
  assert(blocked.length <= 1, 'LIFECYCLE_RESUME_AMBIGUOUS', 'Resume requires a single blocked Feature in the selected Run.');
  const feature = blocked[0] ?? null;
  if (!feature) return null;
  assert(feature.metadata?.stage === 'implementation', 'LIFECYCLE_RESUME_BLOCKED_STAGE', 'The blocked Feature is not an implementation stage.');
  const submission = [...state.submissions].reverse().find(item => item.featureId === feature.id);
  const inScopeFix = submission?.result?.status === 'blocked' && submission.result.blocker?.kind === 'in-scope-fix-blocked';
  const providerFailure = submission?.result?.status === 'failed' && submission.result.failureClass === 'runtime-provider'
    && submission.result.blocker?.kind === 'runtime-provider';
  assert(inScopeFix || providerFailure,
    'LIFECYCLE_RESUME_BLOCKER_REQUIRES_REVIEW', 'The blocked Feature is not an in-scope fix or a retryable provider failure.');
  const attempt = state.attempts[`${feature.logicalRoot}:${submission.result.failureClass}`];
  assert(attempt && !attempt.exhausted, 'LIFECYCLE_RESUME_BUDGET_EXHAUSTED', 'The blocked Feature has exhausted its attempt budget.');
  return feature.id;
};
