import { assert } from '../common/errors.mjs';
import { digestJson } from '../common/canonical.mjs';
import { validateFinding } from '../kernel/quality.mjs';

const carriedOrigin = (state, finding) => {
  if (finding.source !== 'authority-snapshot' || state.metadata?.commandIntent?.action !== 'amend') return null;
  const ref = state.metadata.planRevision?.replacesAmendment;
  const original = ref?.preservedDraft?.openFindings?.find(row => row.id === finding.id);
  const submission = ref?.preservedDraft?.rejectedReview?.submission;
  if (!original || ref.replacementArtifactDigest !== state.artifactDigest || !submission
    || submission.submissionId !== ref.preservedDraft.rejectedReview.submissionId
    || submission.result?.outputs?.['plan-review']?.value?.approved !== false) return null;
  const expected = validateFinding({ ...original, source: 'authority-snapshot', openedAt: finding.openedAt });
  if (digestJson(finding) !== digestJson(expected)) return null;
  return { runId: ref.runId, submission };
};

const reviewValue = submission => submission.result?.outputs?.['plan-review']?.value;
const reviewFeature = (state, id) => state.features.find(feature => feature.id === id
  && feature.metadata?.stage === 'plan-review' && feature.state === 'completed'
  && feature.metadata.sourcePolicy === 'read-only' && feature.allowedPaths.length === 0);
const follows = (state, childId, parentId, visited = new Set()) => {
  if (visited.has(childId)) return false;
  visited.add(childId);
  return state.features.find(feature => feature.id === childId)?.dependsOn.some(id =>
    id === parentId || follows(state, id, parentId, visited)) ?? false;
};
const activeReviews = state => state.submissions.filter(submission => !submission.supersededAt
  && submission.result?.status === 'completed' && reviewFeature(state, submission.featureId));
const explicitlyResolved = (submission, id) => reviewValue(submission)?.resolvedFindings?.includes(id)
  && submission.result.checkpoints?.some(checkpoint => checkpoint.id === id
    && ['resolved', 'passed', 'completed'].includes(checkpoint.status)
    && checkpoint.summary?.trim() && checkpoint.evidence?.length > 0);
const reportedIds = submission => [...(submission.result.findings ?? []).map(finding => finding.id),
  ...(reviewValue(submission)?.findings ?? []).map(finding => typeof finding === 'string'
    ? /^([A-Za-z0-9][A-Za-z0-9._/-]*)\s+\[P[0-3]\]/.exec(finding)?.[1] : finding.id)];

/** Derive only per-Finding, descendant-review resolutions; approval alone resolves nothing. */
export const planReviewResolutionCandidates = (state, legacyAssessments = []) => {
  const reviews = activeReviews(state);
  const latest = reviews.at(-1);
  const result = [];
  const legacyIds = legacyAssessments.map(item => item.id);
  assert(new Set(legacyIds).size === legacyIds.length, 'PLAN_REVIEW_RECONCILIATION_INVALID', 'Duplicate legacy assessments.');
  for (const finding of state.findings.filter(item => item.status === 'open')) {
    const carried = carriedOrigin(state, finding);
    if (finding.source !== 'review' && !carried) continue;
    const origin = carried?.submission ?? reviews.find(submission => submission.featureId === finding.featureId
      && submission.result.findings?.some(item => item.id === finding.id)
      && finding.evidenceRefs.every(ref => submission.evidenceRefs.includes(ref)));
    if (!origin) continue;
    const later = carried ? reviews : reviews.slice(reviews.indexOf(origin) + 1).filter(submission =>
      follows(state, submission.featureId, origin.featureId));
    const explicit = later.find(submission => explicitlyResolved(submission, finding.id)
      && !reportedIds(submission).includes(finding.id)
      && !reviews.slice(reviews.indexOf(submission) + 1).some(item => reportedIds(item).includes(finding.id)));
    let resolving = explicit;
    let assessment = null;
    if (!resolving && !carried && legacyIds.includes(finding.id)) {
      assessment = legacyAssessments.find(item => item.id === finding.id);
      resolving = later.find(submission => submission.submissionId === assessment.reviewSubmissionId);
      const blockers = resolving ? [...new Set(reportedIds(resolving))] : [];
      assert(resolving && latest && reviewValue(latest)?.approved === true
        && (reviewValue(latest).findings ?? []).length === 0 && (latest.result.findings ?? []).length === 0
        && follows(state, latest.featureId, resolving.featureId)
        && reviewValue(resolving)?.previousFindings?.[finding.id] === assessment.quotedAssessment
        && typeof assessment.quotedAssessment === 'string' && assessment.quotedAssessment.trim().length > 0
        && typeof assessment.summary === 'string' && assessment.summary.trim().length >= 32
        && blockers.length > 0 && blockers.every(Boolean)
        && Array.isArray(assessment.supersededBy)
        && digestJson([...new Set(assessment.supersededBy)].sort()) === digestJson([...blockers].sort())
        && blockers.every(id => explicitlyResolved(latest, id))
        && !reviews.slice(reviews.indexOf(resolving)).some(item => reportedIds(item).includes(finding.id)),
      'PLAN_REVIEW_RECONCILIATION_INVALID', 'Legacy resolution requires an exact operator assessment, descendant review and explicit resolution of every successor Finding.');
    }
    if (!resolving) continue;
    const supporting = carried ? [resolving] : assessment ? [origin, resolving, latest] : [origin, resolving];
    result.push({ id: finding.id, submissions: supporting,
      ...(carried ? { carriedOrigin: carried } : {}),
      evidenceRefs: [...new Set([...(carried ? origin.evidenceRefs : []), ...supporting.flatMap(submission => submission.evidenceRefs)])],
      resolution: { status: 'fixed', kind: 'plan-review-evidence-reconciliation',
        ...(carried ? { originRunId: carried.runId, originSubmissionId: origin.submissionId } : {}),
        reviewSubmissionId: resolving.submissionId,
        ...(assessment ? { operatorAssessment: structuredClone(assessment), finalReviewSubmissionId: latest.submissionId } : {}),
        summary: assessment?.summary ?? resolving.result.checkpoints.find(item => item.id === finding.id).summary } });
  }
  assert(legacyIds.every(id => result.some(item => item.id === id)
    || state.findings.some(item => item.id === id && item.status === 'resolved'
      && item.resolution?.operatorAssessment
      && digestJson(item.resolution.operatorAssessment) === digestJson(legacyAssessments.find(entry => entry.id === id)))),
  'PLAN_REVIEW_RECONCILIATION_INVALID', 'Every legacy assessment must bind an open review Finding or its identical recorded resolution.');
  return result;
};

/** Verify original committed result bytes and context before issuing any Kernel command. */
export const verifyPlanReviewResolutionEvidence = async (state, candidates, evidenceStore) => {
  for (const candidate of candidates.filter(item => item.carriedOrigin)) {
    await verifyPlanReviewResolutionEvidence({ ...state, runId: candidate.carriedOrigin.runId },
      [{ submissions: [candidate.carriedOrigin.submission] }], evidenceStore);
  }
  const submissions = [...new Map(candidates.flatMap(item => item.submissions)
    .map(submission => [submission.submissionId, submission])).values()];
  for (const submission of submissions) {
    const { submissionDigest, ...body } = submission;
    assert(submissionDigest === digestJson(body) && submission.evidenceRefs.length > 0,
      'PLAN_REVIEW_EVIDENCE_MISMATCH', 'Review Submission digest or Evidence is missing.');
    for (const ref of submission.evidenceRefs) {
      const evidence = await evidenceStore.read(ref);
      const stored = JSON.parse(evidence.bytes.toString('utf8'));
      assert(stored?.result && typeof stored.result === 'object'
        && evidence.metadata.projectId === state.projectId && evidence.metadata.runId === state.runId
        && evidence.metadata.featureId === submission.featureId && evidence.metadata.dispatchId === submission.dispatchId
        && evidence.metadata.epoch === submission.epoch && evidence.metadata.generation === submission.generation
        && digestJson(stored.result) === digestJson(submission.result)
        && stored.inputSourceDigest === submission.inputSourceDigest
        && stored.outputSourceDigest === submission.outputSourceDigest,
      'PLAN_REVIEW_EVIDENCE_MISMATCH', 'Resolution Evidence does not match the committed review Submission.');
    }
  }
};

export const reconcilePlanReviewFindings = async ({ state, kernel, evidenceStore, commandId, legacyAssessments = [] }) => {
  const candidates = planReviewResolutionCandidates(state, legacyAssessments);
  await verifyPlanReviewResolutionEvidence(state, candidates, evidenceStore);
  let current = state;
  for (const candidate of candidates) {
    const output = await kernel.resolveFinding(state.projectId, state.runId,
      { id: candidate.id, evidenceRefs: candidate.evidenceRefs, resolution: candidate.resolution },
      { expectedRevision: current.revision, commandId: `${commandId}.resolve.${candidate.id}` });
    current = output.state;
  }
  return { state: current, resolvedIds: candidates.map(item => item.id) };
};
