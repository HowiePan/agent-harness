import { assert } from '../common/errors.mjs';
import { digestJson, withoutKeys } from '../common/canonical.mjs';
import { validateFinding } from '../kernel/quality.mjs';
import { isBoundIntervention } from './interruption-review.mjs';
import { featureContractDigest } from '../common/interruption-contract.mjs';

const idle = state => !state.leases.some(row => row.status === 'active')
  && !state.dispatches.some(row => ['requested', 'assigned'].includes(row.status));

export const hasCompletedAmendmentWork = state => state.submissions.some(row => row.result?.status === 'completed'
  && !state.features.some(feature => feature.id === row.featureId && isBoundIntervention(state, feature)));

/** A rejected candidate remains unapproved input after a bounded planning failure. */
export const rejectedAmendmentDraftEvidence = state => {
  if (state.metadata?.commandIntent?.action !== 'amend'
    || state.decisions?.some(row => row.id === 'implementation-plan-approved' && row.decision === 'approved')
    || state.features.some(row => !isBoundIntervention(state, row) && !['version-planning', 'plan-review'].includes(row.metadata?.stage))) return null;
  const auxiliary = new Set(state.features.filter(row => isBoundIntervention(state, row)).map(row => row.id));
  const submitted = state.submissions.filter(row => !row.supersededAt && !auxiliary.has(row.featureId));
  const stage = row => state.features.find(feature => feature.id === row.featureId)?.metadata?.stage;
  const reviews = submitted.filter(row => stage(row) === 'plan-review' && row.result?.status === 'completed');
  if (reviews.some(row => row.result.outputs?.['plan-review']?.value?.approved === true)) return null;
  const review = reviews.at(-1), decision = review?.result.outputs?.['plan-review']?.value;
  const planner = submitted.findLast(row => stage(row) === 'version-planning' && row.result?.status === 'completed');
  const blocked = submitted.at(-1), failure = blocked?.result;
  const feature = state.features.find(row => row.id === blocked?.featureId);
  const revision = state.metadata.planRevision, candidate = planner?.result.outputs?.amendment?.value;
  const formatBlocked = failure?.failureClass === 'protected-plan-blocker'
    && failure.blocker?.kind === 'protected' && failure.blocker.code === 'PLAN_AMENDMENT_TOO_LARGE';
  const reconciliationBlocked = failure?.failureClass === 'scope-blocker' && failure.blocker?.kind === 'scope'
    && Number.isInteger(feature?.metadata?.planReviewRound) && feature.metadata.planReviewRound >= 2
    && Number.isInteger(state.profile?.config?.planReviewLimit)
    && (feature.metadata.planReviewRound - 1
      + (revision?.replacesAmendment?.preservedDraft?.reviewRoundsUsed ?? 0)) < state.profile.config.planReviewLimit
    && (feature.allowedPaths ?? []).length > 0
    && feature.allowedPaths.every(path => path === revision?.amendmentScope?.artifactRoot)
    && state.features.filter(row => auxiliary.has(row.id)).some(row => {
      const spec = row.metadata.intervention;
      const diagnostic = state.submissions.find(item => item.submissionId === row.submissionId);
      const value = diagnostic?.result?.outputs?.diagnosis?.value;
      return spec.sourceFeatureId === feature.id && spec.sourceSubmissionId === blocked.submissionId
        && spec.sourceDigest === state.sourceDigest && spec.contractDigest === featureContractDigest(feature)
        && value?.sourceSubmissionId === spec.sourceSubmissionId && value.contractDigest === spec.contractDigest
        && value.conclusion === 'unresolved'
        && diagnostic.changedFiles?.length === 0 && diagnostic.inputSourceDigest === state.sourceDigest
        && diagnostic.outputSourceDigest === state.sourceDigest && diagnostic.evidenceRefs?.length
        && diagnostic.submissionDigest === digestJson(withoutKeys(diagnostic, ['submissionDigest']))
        && state.dispatches.some(dispatch => dispatch.dispatchId === diagnostic.dispatchId
          && dispatch.status === 'committed' && dispatch.submissionId === diagnostic.submissionId);
    });
  const expectedFeatures = [...revision?.amendmentScope?.featureIds ?? [],
    ...Object.values(revision?.amendmentScope?.featureSplits ?? []).flatMap(split => {
      // The exact materialized review may include registered appended children.
      const prefix = split.prefix;
      const children = prefix ? (decision?.reviewedFeatureIds ?? []).filter(id => id.startsWith(prefix) && id.length > prefix.length
        && !revision.parentPlan?.proposedFeatures?.some(row => row.id === id)) : [];
      return children.length <= split.maxNewFeatures ? children : [];
    })];
  if (!revision || !candidate?.deltaRef || candidate.plan || candidate.version !== 'plan-amendment/1'
    || candidate.basePlanDigest !== revision.parentPlanDigest || candidate.changeRequestDigest !== revision.changeRequestDigest
    || !candidate.deltaRef.path?.startsWith(`${revision.amendmentScope.artifactRoot}/`)
    || !/^[a-f0-9]{64}$/.test(candidate.deltaRef.sha256 ?? '')
    || decision?.approved !== false || !Array.isArray(decision.findings) || !decision.findings.length
    || !Array.isArray(decision.reviewedFeatureIds)
    || decision.basePlanDigest !== revision.parentPlanDigest || !/^[a-f0-9]{64}$/.test(decision.deltaDigest ?? '')
    || digestJson([...decision.reviewedFeatureIds].sort()) !== digestJson([...new Set(expectedFeatures)].sort())
    || failure?.status !== 'blocked' || !(formatBlocked || reconciliationBlocked)
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
  return { planner, review, blocked, openFindings,
    ...(reconciliationBlocked ? { reviewRoundsUsed: feature.metadata.planReviewRound - 1
      + (revision?.replacesAmendment?.preservedDraft?.reviewRoundsUsed ?? 0) } : {}) };
};

/** A fresh, source-bound diagnostic may justify registering a bounded batch correction.
 * The rejected candidate and its open review remain unapproved inherited input. */
export const diagnosedAmendmentScopeEvidence = state => {
  const revision = state.metadata?.planRevision, ref = revision?.replacesAmendment;
  const saved = ref?.preservedDraft, review = saved?.rejectedReview?.submission;
  const auxiliary = new Set(state.features.filter(row => isBoundIntervention(state, row)).map(row => row.id));
  const submissions = state.submissions.filter(row => !row.supersededAt && !auxiliary.has(row.featureId));
  const blocked = submissions.at(-1), feature = state.features.find(row => row.id === blocked?.featureId);
  const committed = row => row?.evidenceRefs?.length
    && row.submissionDigest === digestJson(withoutKeys(row, ['submissionDigest']))
    && state.dispatches.some(item => item.dispatchId === row.dispatchId && item.status === 'committed'
      && item.submissionId === row.submissionId);
  if (state.metadata?.commandIntent?.action !== 'amend'
    || state.decisions?.some(row => row.id === 'implementation-plan-approved' && row.decision === 'approved')
    || saved?.acceptance !== 'unaccepted-requires-planning-and-review'
    || !saved.deltaRef || saved.rejectedReview?.submissionId !== review?.submissionId
    || review?.result?.outputs?.['plan-review']?.value?.approved !== false
    || review.result.outputs['plan-review'].value.basePlanDigest !== revision.parentPlanDigest
    || review.submissionDigest !== digestJson(withoutKeys(review, ['submissionDigest']))
    || !review.evidenceRefs?.length || review.changedFiles?.length !== 0
    || review.inputSourceDigest !== review.outputSourceDigest
    || !Number.isInteger(saved.reviewRoundsUsed) || saved.reviewRoundsUsed < 1
    || saved.reviewRoundsUsed >= state.profile?.config?.planReviewLimit
    || submissions.length !== 1 || blocked.result?.status !== 'blocked'
    || blocked.result.failureClass !== 'scope-blocker' || blocked.result.blocker?.kind !== 'scope'
    || feature?.metadata?.stage !== 'version-planning' || feature.state !== 'blocked'
    || digestJson(feature.blocker) !== digestJson(blocked.result.blocker)
    || !(feature.allowedPaths?.length > 0) || feature.allowedPaths.some(path => path !== revision.amendmentScope.artifactRoot)
    || state.features.some(row => !auxiliary.has(row.id) && !['version-planning', 'plan-review'].includes(row.metadata?.stage))
    || blocked.outputSourceDigest !== state.sourceDigest || !committed(blocked)) return null;
  const open = (state.findings ?? []).filter(row => row.status !== 'resolved');
  if (!saved.openFindings?.length || open.length !== saved.openFindings.length
    || open.some(row => {
      const original = saved.openFindings.find(item => item.id === row.id);
      return !original || row.status !== 'open' || original.status !== 'open'
        || !review.result.findings?.some(item => item.id === original.id)
        || digestJson(row) !== digestJson(validateFinding({ ...original, source: 'authority-snapshot', openedAt: row.openedAt }));
    })) return null;
  // Use the latest diagnostic, including any bounded correction; an earlier
  // scope-expanding repairPaths claim cannot override its corrected outcome.
  const diagnostic = state.submissions.findLast(row => !row.supersededAt && auxiliary.has(row.featureId));
  const probe = state.features.find(row => row.id === diagnostic?.featureId), spec = probe?.metadata.intervention;
  const value = diagnostic?.result?.outputs?.diagnosis?.value;
  if (probe?.state !== 'completed' || probe.allowedPaths?.length !== 0 || diagnostic?.result?.status !== 'completed'
    || spec.sourceFeatureId !== feature.id || spec.sourceSubmissionId !== blocked.submissionId
    || spec.sourceDigest !== state.sourceDigest || spec.contractDigest !== featureContractDigest(feature)
    || value?.conclusion !== 'contract-change' || value.repairPaths?.length !== 0
    || value.sourceSubmissionId !== blocked.submissionId || value.contractDigest !== spec.contractDigest
    || diagnostic.changedFiles?.length !== 0 || diagnostic.inputSourceDigest !== state.sourceDigest
    || diagnostic.outputSourceDigest !== state.sourceDigest || !committed(diagnostic)) return null;
  return { blocked, diagnostic, preservedDraft: { ...structuredClone(saved),
    rejectedReview: { ...structuredClone(saved.rejectedReview),
      originRunId: saved.rejectedReview.originRunId ?? ref.runId },
    correctedDraft: { submissionId: blocked.submissionId, evidenceRefs: blocked.evidenceRefs,
      changedFiles: blocked.changedFiles, outputSourceDigest: blocked.outputSourceDigest },
    scopeCorrection: { submissionId: diagnostic.submissionId, evidenceRefs: diagnostic.evidenceRefs,
      sourceSubmissionId: blocked.submissionId, sourceDigest: state.sourceDigest, contractDigest: spec.contractDigest } } };
};

const preservedDraft = state => state.metadata?.unacceptedPlanningResult ? {
  evidenceRef: state.metadata.unacceptedPlanningResult.evidenceRef,
  deltaRef: state.metadata.unacceptedPlanningResult.deltaRef,
  observedSourceDigest: state.metadata.unacceptedPlanningResult.observedSourceDigest,
  acceptance: 'unaccepted-requires-planning-and-review',
} : (() => {
  const evidence = rejectedAmendmentDraftEvidence(state);
  return evidence ? { acceptance: 'unaccepted-requires-planning-and-review',
    ...(evidence.reviewRoundsUsed ? { reviewRoundsUsed: evidence.reviewRoundsUsed } : {}),
    deltaRef: structuredClone(evidence.planner.result.outputs.amendment.value.deltaRef),
    rejectedReview: { submissionId: evidence.review.submissionId, evidenceRefs: evidence.review.evidenceRefs,
      value: structuredClone(evidence.review.result.outputs['plan-review'].value),
      ...(evidence.openFindings.length ? { submission: structuredClone(evidence.review) } : {}) },
    ...(evidence.openFindings.length ? { openFindings: structuredClone(evidence.openFindings) } : {}),
    correctedDraft: { submissionId: evidence.blocked.submissionId, evidenceRefs: evidence.blocked.evidenceRefs,
      changedFiles: evidence.blocked.changedFiles, outputSourceDigest: evidence.blocked.outputSourceDigest } }
    : diagnosedAmendmentScopeEvidence(state)?.preservedDraft ?? null;
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
  && !hasCompletedAmendmentWork(state);

const extendsScope = (state, after) => {
  const same = (a, b) => digestJson(a) === digestJson(b);
  const includes = (a, b) => a.every(value => b.includes(value));
  const revision = state.metadata.planRevision;
  const before = revision.amendmentScope;
  if (!before || !after) return false;
  const sameFeatures = same(before.featureIds, after.featureIds);
  // Only a scope-blocked draft with no authored output may append existing
  // project-owned work to its registered review boundary.
  const diagnosed = diagnosedAmendmentScopeEvidence(state);
  const batchCorrection = () => {
    if (!diagnosed || !same(before.batchPolicy ?? null, after.batchPolicy ?? null)
      || !same(before.featureSplits ?? [], after.featureSplits ?? [])) return false;
    const added = after.planPointers.filter(path => !before.planPointers.includes(path));
    if (!added.length || !added.every(path => {
      const match = /^\/proposedFeatures\/(0|[1-9][0-9]*)\/deliveryBatches$/.exec(path);
      const proposal = match && revision.parentPlan?.proposedFeatures?.[Number(match[1])];
      return proposal && after.featureIds.includes(proposal.id) && proposal.projectId === state.projectId
        && proposal.disposition === 'project-owned' && proposal.deliveryBatches?.length
        && !revision.implementationBaselines?.some(baseline => baseline.completed?.some(item => item.proposalId === proposal.id));
    })) return false;
    return before.documents.every((doc, index) => {
      const next = after.documents[index];
      return next && same(next.allowedPointers.filter(path => !doc.allowedPointers.includes(path)).sort(), [...added].sort());
    });
  };
  const expandsFeatures = () => (isBlockedAmendmentDraft(state) && !state.metadata.unacceptedPlanningResult
    && !state.submissions.some(row => row.changedFiles?.length) || batchCorrection())
    && !state.decisions?.some(row => row.id === 'implementation-plan-approved' && row.decision === 'approved')
    && after.featureIds.length > before.featureIds.length
    && same(before.featureIds, after.featureIds.slice(0, before.featureIds.length))
    && after.featureIds.slice(before.featureIds.length).every(id => revision.parentPlan?.proposedFeatures?.some(item =>
      item.id === id && item.projectId === state.projectId && item.disposition === 'project-owned')
      && !revision.implementationBaselines?.some(baseline => baseline.completed?.some(item => item.proposalId === id)))
    && same(before.batchPolicy ?? null, after.batchPolicy ?? null)
    && (before.featureSplits ?? []).every(split => (after.featureSplits ?? []).some(item => same(split, item)));
  return before && after && same(before.version, after.version) && same(before.artifactRoot, after.artifactRoot)
    && (!diagnosed || batchCorrection())
    && (sameFeatures || expandsFeatures())
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
  assert((isBlockedAmendmentDraft(prior) || sameRequest && runtimeChanged && repairableRejectedDraft(prior)
    || !sameRequest && idle(prior) && prior.status === 'ready' && diagnosedAmendmentScopeEvidence(prior))
    && prior.metadata.commandIntent.selector === intent.selector
    && revision.parentRunId === parentRunId && revision.parentPlanDigest === parentPlanDigest
    && extendsScope(prior, scope)
    && (!sameRequest || digestJson(revision.amendmentScope) === digestJson(scope)),
  'PLAN_AMENDMENT_RETRY_UNSAFE', 'A retry must preserve the exact base, selector and artifact identity. Scoped batch corrections require a committed contract-change diagnosis, unapproved ancestry, unchanged policy and remaining review allowance.');
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
      || idle(state) && ['ready', 'superseded'].includes(state.status) && diagnosedAmendmentScopeEvidence(state)
      || runtimeRepair && repairableRejectedDraft(state))
    && digestJson(ref.preservedDraft ?? null) === digestJson(preservedDraft(state))
    && state.metadata.commandIntent.selector === plan.intent.selector
    && state.metadata.planRevision.parentRunId === plan.intent.planRevision.parentRunId
    && state.metadata.planRevision.parentPlanDigest === plan.intent.planRevision.parentPlanDigest
    && (!ref.replacementArtifactDigest || runtimeRepair)
    && (state.metadata.planRevision.changeRequestDigest !== plan.intent.planRevision.changeRequestDigest
      || runtimeRepair && digestJson(state.metadata.planRevision.amendmentScope) === digestJson(plan.intent.planRevision.amendmentScope))
    && extendsScope(state, plan.intent.planRevision.amendmentScope));
};
