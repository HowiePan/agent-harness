import { assert } from '../common/errors.mjs';
import { digestJson, withoutKeys } from '../common/canonical.mjs';
import { validateFinding } from '../kernel/quality.mjs';

const idle = state => !state.leases.some(row => row.status === 'active')
  && !state.dispatches.some(row => ['requested', 'assigned'].includes(row.status));

/** Only a rejected, unapproved candidate followed by this bounded format blocker. */
export const rejectedAmendmentDraftEvidence = state => {
  if (state.metadata?.commandIntent?.action !== 'amend'
    || state.decisions?.some(row => row.id === 'implementation-plan-approved' && row.decision === 'approved')
    || state.features.some(row => !['version-planning', 'plan-review'].includes(row.metadata?.stage))) return null;
  const submitted = state.submissions.filter(row => !row.supersededAt);
  const stage = row => state.features.find(feature => feature.id === row.featureId)?.metadata?.stage;
  const reviews = submitted.filter(row => stage(row) === 'plan-review' && row.result?.status === 'completed');
  if (reviews.some(row => row.result.outputs?.['plan-review']?.value?.approved === true)) return null;
  const review = reviews.at(-1), decision = review?.result.outputs?.['plan-review']?.value;
  const planner = submitted.findLast(row => stage(row) === 'version-planning' && row.result?.status === 'completed');
  const blocked = submitted.at(-1), failure = blocked?.result;
  const feature = state.features.find(row => row.id === blocked?.featureId);
  const revision = state.metadata.planRevision, candidate = planner?.result.outputs?.amendment?.value;
  if (!revision || !candidate?.deltaRef || candidate.plan || candidate.version !== 'plan-amendment/1'
    || candidate.basePlanDigest !== revision.parentPlanDigest || candidate.changeRequestDigest !== revision.changeRequestDigest
    || !candidate.deltaRef.path?.startsWith(`${revision.amendmentScope.artifactRoot}/`)
    || !/^[a-f0-9]{64}$/.test(candidate.deltaRef.sha256 ?? '')
    || decision?.approved !== false || !Array.isArray(decision.findings) || !decision.findings.length
    || !Array.isArray(decision.reviewedFeatureIds)
    || decision.basePlanDigest !== revision.parentPlanDigest || !/^[a-f0-9]{64}$/.test(decision.deltaDigest ?? '')
    || digestJson([...decision.reviewedFeatureIds].sort()) !== digestJson([...revision.amendmentScope.featureIds].sort())
    || failure?.status !== 'blocked' || failure.failureClass !== 'protected-plan-blocker'
    || failure.blocker?.kind !== 'protected' || failure.blocker.code !== 'PLAN_AMENDMENT_TOO_LARGE'
    || feature?.metadata?.stage !== 'version-planning' || feature.state !== 'blocked'
    || digestJson(feature.blocker) !== digestJson(failure.blocker)
    || blocked.outputSourceDigest !== state.sourceDigest
    || !(submitted.indexOf(planner) < submitted.indexOf(review) && submitted.indexOf(review) < submitted.indexOf(blocked))
    || [planner, review, blocked].some(row => !row.submissionId || !row.evidenceRefs?.length
      || row.submissionDigest !== digestJson(withoutKeys(row, ['submissionDigest']))
      || !state.dispatches.some(dispatch => dispatch.dispatchId === row.dispatchId && dispatch.status === 'committed'
        && dispatch.submissionId === row.submissionId))) return null;
  // Only Findings opened by this exact rejected review may cross the retry.
  // Preserve them as open; runtime repair is never a Finding resolution.
  const openFindings = (state.findings ?? []).filter(row => row.status !== 'resolved');
  if (openFindings.some(row => row.status !== 'open' || typeof row.openedAt !== 'string'
    || !(review.result.findings ?? []).some(intent => digestJson(row) === digestJson(validateFinding({
      ...intent, source: 'review', featureId: review.featureId, evidenceRefs: review.evidenceRefs,
      status: 'open', openedAt: row.openedAt,
    }))))) return null;
  return { planner, review, blocked, openFindings };
};

const preservedDraft = state => state.metadata?.unacceptedPlanningResult ? {
  evidenceRef: state.metadata.unacceptedPlanningResult.evidenceRef,
  deltaRef: state.metadata.unacceptedPlanningResult.deltaRef,
  observedSourceDigest: state.metadata.unacceptedPlanningResult.observedSourceDigest,
  acceptance: 'unaccepted-requires-planning-and-review',
} : (() => {
  const evidence = rejectedAmendmentDraftEvidence(state);
  return evidence ? { acceptance: 'unaccepted-requires-planning-and-review',
    deltaRef: structuredClone(evidence.planner.result.outputs.amendment.value.deltaRef),
    rejectedReview: { submissionId: evidence.review.submissionId, evidenceRefs: evidence.review.evidenceRefs,
      value: structuredClone(evidence.review.result.outputs['plan-review'].value),
      ...(evidence.openFindings.length ? { submission: structuredClone(evidence.review) } : {}) },
    ...(evidence.openFindings.length ? { openFindings: structuredClone(evidence.openFindings) } : {}),
    correctedDraft: { submissionId: evidence.blocked.submissionId, evidenceRefs: evidence.blocked.evidenceRefs,
      changedFiles: evidence.blocked.changedFiles, outputSourceDigest: evidence.blocked.outputSourceDigest } } : null;
})();

const repairableRejectedDraft = state => state.status === 'ready' && idle(state)
  && Boolean(rejectedAmendmentDraftEvidence(state));

export const isBlockedAmendmentDraft = state => state.metadata?.commandIntent?.action === 'amend'
  && state.status === 'ready' && idle(state)
  && !state.findings?.some(row => row.status !== 'resolved')
  && state.features.some(row => row.metadata?.stage === 'version-planning' && row.state === 'blocked'
    && row.blocker?.kind === 'scope')
  && (state.submissions.some(row => row.result?.status === 'blocked' && row.result.failureClass === 'scope-blocker')
    || state.metadata.unacceptedPlanningResult?.evidenceRef && state.submissions.length === 0)
  && !state.submissions.some(row => row.result?.status === 'completed');

const extendsScope = (before, after) => {
  const same = (a, b) => digestJson(a) === digestJson(b);
  const includes = (a, b) => a.every(value => b.includes(value));
  return before && after && same(before.version, after.version) && same(before.artifactRoot, after.artifactRoot)
    && same(before.featureIds, after.featureIds)
    && same(before.baselineCompatibilityPaths ?? [], after.baselineCompatibilityPaths ?? [])
    && includes(before.planPointers, after.planPointers)
    && before.documents.length === after.documents.length
    && before.documents.every((doc, index) => {
      const next = after.documents[index];
      return same(doc.id, next.id) && same(doc.source, next.source) && same(doc.outputPath, next.outputPath)
        && includes(doc.allowedPointers, next.allowedPointers);
    });
};

/** A new human command may replace only an idle, unaccepted scope-blocked draft. */
export const selectAmendmentRetry = ({ states, intent, parentRunId, parentPlanDigest, request, scope, artifactDigest = null }) => {
  const candidates = states.filter(state => !['closed', 'failed', 'incomplete', 'superseded'].includes(state.status)
    && state.metadata?.commandIntent?.action === 'amend'
    && state.metadata.commandIntent.target === intent.target
    && state.metadata.commandIntent.workflowId === intent.workflowId);
  assert(candidates.length <= 1, 'PLAN_AMENDMENT_RETRY_AMBIGUOUS', 'More than one unfinished amendment exists.');
  if (!candidates.length) return null;
  const prior = candidates[0];
  const revision = prior.metadata.planRevision;
  const sameRequest = revision?.changeRequestDigest === digestJson(request);
  const runtimeChanged = /^[a-f0-9]{64}$/.test(artifactDigest ?? '')
    && /^[a-f0-9]{64}$/.test(prior.artifactDigest ?? '') && artifactDigest !== prior.artifactDigest;
  // Support-only changes keep the old immutable Plan. A verified runtime repair
  // requires a new Run, without inventing a scope edit just to unblock retry.
  if (sameRequest && !runtimeChanged) return null;
  assert((isBlockedAmendmentDraft(prior) || sameRequest && runtimeChanged && repairableRejectedDraft(prior))
    && prior.metadata.commandIntent.selector === intent.selector
    && revision.parentRunId === parentRunId && revision.parentPlanDigest === parentPlanDigest
    && extendsScope(revision.amendmentScope, scope)
    && (!sameRequest || digestJson(revision.amendmentScope) === digestJson(scope)),
  'PLAN_AMENDMENT_RETRY_UNSAFE', 'A revised scope must preserve the exact base, selector, affected Features and artifact identity; only an idle unaccepted scope-blocked draft can be replaced.');
  return { runId: prior.runId, revision: prior.revision, authorityDigest: prior.authorityDigest,
    lifecyclePlanDigest: prior.metadata.lifecyclePlanDigest, sourceDigest: prior.sourceDigest,
    ...(preservedDraft(prior) ? { preservedDraft: preservedDraft(prior) } : {}),
    ...(runtimeChanged ? { replacementArtifactDigest: artifactDigest } : {}) };
};

export const matchesAmendmentRetry = (state, plan) => {
  const ref = plan.intent?.planRevision?.replacesAmendment;
  const runtimeRepair = Boolean(ref?.replacementArtifactDigest
    && /^[a-f0-9]{64}$/.test(state.artifactDigest ?? '')
    && ref.replacementArtifactDigest !== state.artifactDigest
    && ref.replacementArtifactDigest === plan.harness?.artifactDigest);
  return Boolean(ref && ref.runId === state.runId && ref.revision === state.revision
    && ref.authorityDigest === state.authorityDigest && ref.lifecyclePlanDigest === state.metadata.lifecyclePlanDigest
    && ref.sourceDigest === state.sourceDigest && (isBlockedAmendmentDraft(state)
      || runtimeRepair && repairableRejectedDraft(state))
    && digestJson(ref.preservedDraft ?? null) === digestJson(preservedDraft(state))
    && state.metadata.commandIntent.selector === plan.intent.selector
    && state.metadata.planRevision.parentRunId === plan.intent.planRevision.parentRunId
    && state.metadata.planRevision.parentPlanDigest === plan.intent.planRevision.parentPlanDigest
    && (!ref.replacementArtifactDigest || runtimeRepair)
    && (state.metadata.planRevision.changeRequestDigest !== plan.intent.planRevision.changeRequestDigest
      || runtimeRepair && digestJson(state.metadata.planRevision.amendmentScope) === digestJson(plan.intent.planRevision.amendmentScope))
    && extendsScope(state.metadata.planRevision.amendmentScope, plan.intent.planRevision.amendmentScope));
};
