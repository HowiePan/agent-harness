import { digestJson, withoutKeys } from '../common/canonical.mjs';
import { assert } from '../common/errors.mjs';

const mutableFeatureKeys = ['state', 'submissionId', 'blocker', 'reopenedAt', 'reopenReason',
  'recoveryDisposition', 'recoveryEvidenceRefs'];
const implementation = state => state.features.filter(feature => feature.metadata?.stage === 'implementation');
const staticFeature = feature => {
  const stable = withoutKeys(feature, mutableFeatureKeys);
  if (!stable.metadata?.workflow) return stable;
  return { ...stable, metadata: { ...stable.metadata,
    workflow: withoutKeys(stable.metadata.workflow, ['artifactDigest']) } };
};
const workflowDigest = features => {
  const values = [...new Set(features.map(feature => feature.metadata?.workflow?.artifactDigest ?? null))];
  assert(values.length === 1, 'CARRYOVER_WORKFLOW_IDENTITY_INCONSISTENT', 'Implementation Features disagree about their Workflow artifact.');
  return values[0];
};
export const implementationGraphDigest = features => digestJson(features.filter(feature => feature.metadata?.stage === 'implementation')
  .map(staticFeature));
export const completionCarryoverDigest = plan => digestJson(withoutKeys(plan, ['carryoverDigest']));

export const selectCompletionCarryoverSource = (states, plan) => {
  const sources = states.filter(candidate => candidate.status === 'superseded'
    && candidate.metadata?.completionCarryover?.plan?.replacementRunId === plan.run.runId
    && candidate.metadata?.completionCarryover?.plan?.replacementPlanDigest === plan.planDigest);
  assert(sources.length <= 1, 'CARRYOVER_SOURCE_AMBIGUOUS', 'More than one retired Run claims this replacement Plan.');
  const source = sources[0] ?? null;
  if (source) assert(source.metadata.completionCarryover.replacementPlan?.planDigest === plan.planDigest,
    'CARRYOVER_REPLACEMENT_PLAN_MISMATCH', 'Retired Run does not contain the exact replacement Plan.');
  return source;
};

export const createCompletionCarryoverPlan = ({ prior, replacementFeatures, replacementRunId,
  replacementPlanDigest, patchReceiptDigest, sourceDigest, includeIncomplete = false }) => {
  assert(prior.metadata?.commandIntent?.action === 'implement' && prior.status !== 'closed' && prior.status !== 'superseded',
    'CARRYOVER_SOURCE_RUN_INVALID', 'Completion carry-over requires an unfinished implementation Run.');
  assert(sourceDigest === prior.sourceDigest, 'CARRYOVER_SOURCE_CHANGED', 'Completion carry-over requires the exact authoritative source snapshot.');
  assert(!prior.findings.some(finding => finding.status !== 'resolved'), 'CARRYOVER_OPEN_FINDINGS', 'Open Findings require separate resolution before completion carry-over.');
  const oldFeatures = implementation(prior);
  const newFeatures = replacementFeatures.filter(feature => feature.metadata?.stage === 'implementation');
  assert(oldFeatures.length > 0 && implementationGraphDigest(oldFeatures) === implementationGraphDigest(newFeatures),
    'CARRYOVER_FEATURE_GRAPH_CHANGED', 'Implementation Feature definitions changed across the Harness patch.');
  const priorWorkflowDigest = workflowDigest(oldFeatures);
  const replacementWorkflowDigest = workflowDigest(newFeatures);
  assert((priorWorkflowDigest === null && replacementWorkflowDigest === null)
    || (/^[a-f0-9]{64}$/.test(priorWorkflowDigest ?? '') && /^[a-f0-9]{64}$/.test(replacementWorkflowDigest ?? '')),
  'CARRYOVER_WORKFLOW_IDENTITY_INVALID', 'Workflow artifact rebinding requires exact old and new digests.');
  const completed = oldFeatures.filter(feature => feature.state === 'completed');
  const partial = completed.length === 0 && includeIncomplete ? prior.submissions.filter(item =>
    oldFeatures.some(feature => feature.id === item.featureId)
    && ['blocked', 'failed'].includes(item.result?.status) && !item.supersededAt
    && prior.dispatches.some(dispatch => dispatch.dispatchId === item.dispatchId && dispatch.status === 'committed')) : [];
  assert(completed.length > 0 || partial.length > 0, 'CARRYOVER_NO_COMPLETIONS',
    'Carry-over requires completed Features or an explicitly verified committed partial implementation.');
  const firstPending = oldFeatures.findIndex(feature => feature.state !== 'completed');
  assert(firstPending >= 0 && oldFeatures.slice(firstPending).every(feature => feature.state !== 'completed'),
    'CARRYOVER_COMPLETION_ORDER_INVALID', 'Completed Features must form the verified prefix of the implementation graph.');
  const completedSubmissions = completed.map(feature => {
    const submission = prior.submissions.find(item => item.submissionId === feature.submissionId && item.featureId === feature.id
      && item.result?.status === 'completed' && !item.supersededAt);
    assert(submission?.evidenceRefs?.length > 0 && submission.submissionDigest === digestJson(withoutKeys(submission, ['submissionDigest'])),
      'CARRYOVER_COMPLETION_EVIDENCE_INVALID', `Completed Feature ${feature.id} lacks a valid Submission and Evidence reference.`);
    return { featureId: feature.id, submissionId: submission.submissionId,
      submissionDigest: submission.submissionDigest, evidenceRefs: [...submission.evidenceRefs] };
  });
  const partialSubmissions = partial.map(submission => {
    assert(submission.evidenceRefs?.length > 0
      && submission.submissionDigest === digestJson(withoutKeys(submission, ['submissionDigest'])),
    'CARRYOVER_PARTIAL_EVIDENCE_INVALID', 'Partial implementation requires an unchanged committed Submission and Evidence.');
    return { featureId: submission.featureId, submissionId: submission.submissionId,
      submissionDigest: submission.submissionDigest, evidenceRefs: [...submission.evidenceRefs] };
  });
  const body = { protocolVersion: '1.0', kind: 'completion-carryover-plan', projectId: prior.projectId,
    priorRunId: prior.runId, priorAuthorityDigest: prior.authorityDigest, priorRevision: prior.revision,
    replacementRunId, replacementPlanDigest, sourceDigest,
    patchReceiptDigest, implementationGraphDigest: implementationGraphDigest(oldFeatures),
    priorWorkflowDigest, replacementWorkflowDigest,
    completedSubmissions, firstPendingFeatureId: oldFeatures[firstPending].id,
    ...(partialSubmissions.length ? { progressOnly: true, partialSubmissions } : {}) };
  return { ...body, carryoverDigest: completionCarryoverDigest(body) };
};

export const verifyCompletionCarryover = async ({ plan, prior, replacementFeatures, evidenceStore, authorityStore = null }) => {
  assert(plan?.carryoverDigest === completionCarryoverDigest(plan)
    && plan.projectId === prior.projectId && plan.priorRunId === prior.runId
    && plan.sourceDigest === prior.sourceDigest
    && plan.implementationGraphDigest === implementationGraphDigest(replacementFeatures),
  'CARRYOVER_PLAN_MISMATCH', 'Completion carry-over plan differs from its Run or replacement Feature graph.');
  const expected = createCompletionCarryoverPlan({ prior: { ...prior, status: prior.status === 'superseded' ? 'ready' : prior.status,
    authorityDigest: plan.priorAuthorityDigest, revision: plan.priorRevision }, replacementFeatures,
  replacementRunId: plan.replacementRunId, replacementPlanDigest: plan.replacementPlanDigest,
  patchReceiptDigest: plan.patchReceiptDigest, sourceDigest: plan.sourceDigest, includeIncomplete: plan.progressOnly === true });
  assert(expected.carryoverDigest === plan.carryoverDigest, 'CARRYOVER_PLAN_MISMATCH', 'Completion carry-over no longer matches the original Feature and Submission ledger.');
  for (const item of [...plan.completedSubmissions, ...(plan.partialSubmissions ?? [])]) {
    const submission = prior.submissions.find(candidate => candidate.submissionId === item.submissionId);
    for (const ref of item.evidenceRefs) {
      const record = await evidenceStore.read(ref);
      let sourceRun = prior;
      const visited = new Set();
      while (record.metadata.runId !== sourceRun.runId) {
        // Superseding a replacement Run records its outbound carry-over in
        // metadata; the immutable start event retains its inbound provenance.
        const link = [...sourceRun.events].reverse().find(event => event.type === 'feature.completion-carried-over')
          ?? sourceRun.metadata?.completionCarryover;
        assert(authorityStore && link?.priorRunId && link?.completedFeatureIds?.includes(item.featureId)
          && !visited.has(sourceRun.runId),
        'CARRYOVER_EVIDENCE_CONTEXT_MISMATCH', 'Completion Evidence has no verified carry-over origin.');
        visited.add(sourceRun.runId);
        const parent = await authorityStore.read(prior.projectId, link.priorRunId);
        const parentPlan = parent.metadata?.completionCarryover?.plan;
        const parentItem = parentPlan?.completedSubmissions?.find(candidate => candidate.featureId === item.featureId
          && candidate.submissionId === item.submissionId && candidate.submissionDigest === item.submissionDigest
          && digestJson(candidate.evidenceRefs) === digestJson(item.evidenceRefs));
        const parentSubmission = parent.submissions.find(candidate => candidate.submissionId === item.submissionId);
        assert(parent.status === 'superseded' && parent.metadata?.supersededByRunId === sourceRun.runId
          && parent.metadata?.supersedePlanDigest === sourceRun.metadata?.lifecyclePlanDigest
          && parentPlan?.carryoverDigest === link.carryoverDigest
          && parentPlan?.replacementRunId === sourceRun.runId
          && parentItem && parentSubmission?.submissionDigest === submission.submissionDigest,
        'CARRYOVER_EVIDENCE_CONTEXT_MISMATCH', 'Completion Evidence carry-over chain differs from Authority.');
        sourceRun = parent;
      }
      assert(record.metadata.projectId === prior.projectId && record.metadata.runId === sourceRun.runId
        && record.metadata.featureId === item.featureId && record.metadata.dispatchId === submission.dispatchId
        && record.metadata.sourceDigest === submission.inputSourceDigest,
      'CARRYOVER_EVIDENCE_CONTEXT_MISMATCH', 'Completion Evidence is not bound to the original Feature, Dispatch, and source.');
    }
  }
  return plan;
};
