import { digestJson, withoutKeys } from '../common/canonical.mjs';
import { assert } from '../common/errors.mjs';

export const MAX_BUDGET_INCREMENT = 20;
export const MAX_BUDGET_LIMIT = 1000;
const terminal = state => ['closed', 'incomplete', 'failed', 'superseded'].includes(state.status);
const used = attempt => attempt.budgetKind === 'progress' ? attempt.used : attempt.failures;

/** Source/evidence are already checked against the managed Dispatch by submit(). */
export const hasSourceProgress = (state, feature, submission) => {
  const ids = new Set(state.features.filter(item => item.logicalRoot === feature.logicalRoot).map(item => item.id));
  return Boolean(submission.inputSourceDigest && submission.outputSourceDigest
    && submission.inputSourceDigest !== submission.outputSourceDigest
    && submission.changedFiles?.length && submission.evidenceRefs?.length
    && !state.submissions.some(item => item.submissionId !== submission.submissionId && ids.has(item.featureId)
      && [item.inputSourceDigest, item.outputSourceDigest].includes(submission.outputSourceDigest)));
};

export const selectAttemptBudget = ({ state, feature, submission, profile }) => {
  const result = submission.result;
  const policy = profile.attemptBudget?.({ state, feature, result });
  const progress = policy?.kind === 'progress' && result.status === 'blocked' && hasSourceProgress(state, feature, submission);
  const budgetKind = progress ? 'progress' : 'failure';
  const key = progress ? `${feature.logicalRoot}:progress` : `${feature.logicalRoot}:${result.failureClass ?? result.status}`;
  const limit = progress ? policy.limit : policy?.failureLimit ?? feature.attemptLimit;
  assert(Number.isSafeInteger(limit) && limit > 0, 'ATTEMPT_BUDGET_INVALID', 'Attempt limits must be finite positive integers.');
  return { key, budgetKind, limit };
};

export const submissionAttempt = (state, feature, submission) => state.attempts?.[
  submission?.attemptBudgetKey ?? `${feature.logicalRoot}:${submission?.result?.failureClass ?? submission?.result?.status}`
];

export const budgetExtensionDigest = proposal => digestJson(withoutKeys(proposal, ['proposalDigest']));

/** Pure, zero-write preview. The extension does not change the Feature contract. */
export const prepareBudgetExtension = ({ state, featureId, attemptKey, additional, reason, remainingWork }) => {
  const feature = state.features.find(item => item.id === featureId);
  const submission = [...state.submissions].reverse().find(item => item.featureId === featureId);
  const attempt = state.attempts[attemptKey];
  assert(!terminal(state) && !state.leases.some(item => ['requested', 'active'].includes(item.status))
    && !state.dispatches.some(item => ['requested', 'assigned'].includes(item.status)),
  'BUDGET_EXTENSION_RUN_NOT_IDLE', 'Budget extension requires an unfinished idle Run.');
  assert(feature && ['blocked', 'failed-budget'].includes(feature.state) && attempt
    && attempt.logicalRoot === feature.logicalRoot && submissionAttempt(state, feature, submission) === attempt,
  'BUDGET_EXTENSION_SCOPE_MISMATCH', 'Extension must identify the latest blocked Feature and its stable budget.');
  assert(Number.isSafeInteger(additional) && additional >= 1 && additional <= MAX_BUDGET_INCREMENT
    && Number.isSafeInteger(attempt.limit) && attempt.limit + additional <= MAX_BUDGET_LIMIT,
  'BUDGET_EXTENSION_LIMIT_INVALID', `Add 1–${MAX_BUDGET_INCREMENT} attempts, with a total limit no greater than ${MAX_BUDGET_LIMIT}.`);
  assert(typeof reason === 'string' && reason.trim().length > 0 && reason.length <= 4000
    && Array.isArray(remainingWork) && remainingWork.length > 0 && remainingWork.length <= 100
    && remainingWork.every(item => typeof item === 'string' && item.trim().length > 0 && item.length <= 4000),
  'BUDGET_EXTENSION_REASON_REQUIRED', 'Explain the extension and list the remaining work.');
  const body = { protocolVersion: '1.0', kind: 'attempt-budget-extension', projectId: state.projectId,
    runId: state.runId, featureId, logicalRoot: feature.logicalRoot, attemptKey,
    epoch: state.epoch, generation: state.generation, authorityDigest: state.authorityDigest,
    expectedRevision: state.revision, sourceDigest: state.sourceDigest,
    planDigest: state.metadata?.lifecyclePlanDigest ?? null,
    latestSubmissionId: submission.submissionId, budgetKind: attempt.budgetKind ?? 'legacy-failure',
    used: used(attempt), beforeLimit: attempt.limit, additional, afterLimit: attempt.limit + additional,
    reason, remainingWork: [...remainingWork] };
  return { ...body, proposalDigest: budgetExtensionDigest(body) };
};

export const assertBudgetExtensionApproval = (proposal, approval) => {
  assert(approval?.action === 'extend-attempt-budget' && approval.decision === 'approved'
    && ['user', 'human-user'].includes(approval.actor) && typeof approval.id === 'string' && approval.id.length > 0
    && approval.projectId === proposal.projectId && approval.runId === proposal.runId
    && approval.featureId === proposal.featureId && approval.proposalDigest === proposal.proposalDigest,
  'BUDGET_EXTENSION_APPROVAL_REQUIRED', 'An explicit human approval must bind this exact budget proposal.');
};
