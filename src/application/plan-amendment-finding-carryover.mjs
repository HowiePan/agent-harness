import { assert } from '../common/errors.mjs';
import { digestJson, withoutKeys } from '../common/canonical.mjs';
import { matchesAmendmentRetry } from './plan-amendment-retry.mjs';
import { verifyPlanReviewResolutionEvidence } from './plan-review-reconciliation.mjs';

const content = finding => withoutKeys(finding,
  ['source', 'status', 'openedAt', 'resolvedAt', 'resolution', 'resolutionEvidenceRefs']);

/** Seed only verified rejected-review Findings through Kernel, before dispatch. */
export const carryAmendmentReviewFindings = async ({ state, plan, authorityStore, evidenceStore, kernel, commandId }) => {
  const ref = plan.intent?.planRevision?.replacesAmendment;
  const pending = ref?.preservedDraft?.openFindings ?? [];
  if (!pending.length) return state;
  assert(state.metadata?.lifecyclePlanDigest === plan.planDigest,
    'PLAN_AMENDMENT_FINDING_CARRYOVER_INVALID', 'Finding carryover must bind the immutable replacement Plan.');
  const missing = pending.filter(finding => {
    const existing = state.findings.find(row => row.id === finding.id);
    assert(!existing || existing.source === 'authority-snapshot'
      && digestJson(content(existing)) === digestJson(content(finding)),
    'PLAN_AMENDMENT_FINDING_CARRYOVER_INVALID', 'A carried Finding changed identity or content.');
    return !existing;
  });
  if (!missing.length) return state;
  const prior = await authorityStore.read(state.projectId, ref.runId);
  assert(matchesAmendmentRetry(prior, plan) && state.submissions.length === 0,
    'PLAN_AMENDMENT_FINDING_CARRYOVER_INVALID', 'Only the exact idle rejected review may seed a fresh replacement Run.');
  await verifyPlanReviewResolutionEvidence(prior,
    [{ submissions: [ref.preservedDraft.rejectedReview.submission] }], evidenceStore);
  let current = state;
  for (const finding of missing) {
    const recorded = await kernel.recordFinding(state.projectId, state.runId,
      { ...structuredClone(finding), source: 'authority-snapshot' },
      { expectedRevision: current.revision, commandId: `${commandId}.carry-review-finding.${finding.id}` });
    current = recorded.state;
  }
  return current;
};
