import { digestJson } from '../common/canonical.mjs';
import { assert } from '../common/errors.mjs';
import { planApprovalSnapshot, planApprovalSatisfied, reviewedPlanProposal } from '../flows/delivery-lifecycle/plan-approval.mjs';
import { validateAmendmentScope } from '../flows/delivery-lifecycle/plan-amendment.mjs';
import { rejectedAmendmentDraftEvidence, selectAmendmentRetry } from './plan-amendment-retry.mjs';
export { diffPlanFeatures } from '../flows/delivery-lifecycle/plan-diff.mjs';

const planOutput = state => {
  const ids = new Set(state.features.filter(feature => feature.metadata?.stage === 'version-planning').map(feature => feature.id));
  return reviewedPlanProposal(state) ?? [...state.submissions].reverse().find(submission => ids.has(submission.featureId)
    && submission.result?.status === 'completed' && !submission.supersededAt)?.result.outputs?.plan?.value ?? null;
};

const unstartedDevelopmentReplacement = (state, states) => state.status === 'superseded'
  && /^development-h[1234]-recovery:[a-f0-9]{64}$/.test(state.metadata?.supersededReason ?? '')
  && Boolean(state.metadata?.supersededByRunId && state.metadata?.supersedePlanDigest)
  && !states.some(candidate => candidate.runId === state.metadata.supersededByRunId);

export const selectPlanRevisionParent = ({ intent, states }) => {
  const candidates = states.filter(state => (state.status !== 'superseded'
  || unstartedDevelopmentReplacement(state, states))
  && ['plan', 'replan', 'amend'].includes(state.metadata?.commandIntent?.action)
  && state.metadata.commandIntent.target === intent.target
  && state.metadata.commandIntent.workflowId === intent.workflowId
  && state.features.some(feature => feature.metadata?.stage === 'plan-review'))
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  const selected = candidates.find(state => planOutput(state) && planApprovalSnapshot(state)) ?? candidates[0] ?? null;
  if (intent.action === 'amend' && selected && rejectedAmendmentDraftEvidence(selected)) {
    const original = candidates.find(state => state.runId === selected.metadata.planRevision.parentRunId);
    if (original?.status === 'closed' && planApprovalSatisfied(original)
      && planApprovalSnapshot(original)?.planDigest === selected.metadata.planRevision.parentPlanDigest) return original;
  }
  return selected;
};

export const preparePlanRevisionIntent = ({ intent, project, states, sourceDigest, sourceChanges = null, amendmentScope = null }) => {
  if (!['replan', 'amend'].includes(intent.action)) return intent;
  const parent = selectPlanRevisionParent({ intent, states });
  assert(parent, 'REPLAN_PARENT_REQUIRED', 'Replan requires an existing plan for the same project, workflow, and target.');
  const snapshot = planApprovalSnapshot(parent);
  const previousPlan = planOutput(parent);
  assert(snapshot && previousPlan, 'REPLAN_PARENT_INCOMPLETE', 'Replan requires a completed prior plan and independent review.');
  const declaration = intent.selector ? project.policy?.planChangeRequests?.[intent.selector] : null;
  if (intent.action === 'amend') {
    assert(parent.status === 'closed' && planApprovalSatisfied(parent),
      'PLAN_AMENDMENT_APPROVED_BASE_REQUIRED', 'Amend requires a closed, user-approved immutable base.');
    assert(intent.selector && declaration, 'PLAN_AMENDMENT_SCOPE_REQUIRED', 'Amend requires an exact registered change selector.');
    validateAmendmentScope(amendmentScope ?? declaration.amendmentScope);
  }
  if (intent.selector) assert(declaration, 'REPLAN_CHANGE_REQUEST_UNKNOWN', 'The selected change request is not registered in the Project Descriptor.');
  if (declaration) {
    assert(declaration.target === intent.target && ['add', 'modify', 'remove', 'defer', 'dependency', 'technical'].includes(declaration.kind)
      && typeof declaration.summary === 'string' && declaration.summary.trim()
      && Array.isArray(declaration.requirements) && declaration.requirements.every(item => typeof item === 'string' && item.trim())
      && Array.isArray(declaration.acceptance) && declaration.acceptance.every(item => typeof item === 'string' && item.trim()),
    'REPLAN_CHANGE_REQUEST_INVALID', 'Change request requires a matching target, kind, summary, requirements, and acceptance list.');
  }
  assert(declaration || parent.sourceDigest !== sourceDigest || snapshot.reviewApproved === false,
    'REPLAN_NO_CHANGE', 'Replan requires a registered change request, changed project source, or a rejected prior review.');
  const changeRequest = declaration ? { id: intent.selector, ...structuredClone(declaration), digest: digestJson(declaration) } : null;
  const replacesAmendment = intent.action === 'amend' ? selectAmendmentRetry({ states, intent,
    parentRunId: parent.runId, parentPlanDigest: snapshot.planDigest, request: declaration,
    scope: amendmentScope ?? declaration.amendmentScope, artifactDigest: project.harness?.artifactDigest }) : null;
  if (sourceChanges) assert(parent.sourceDigest !== sourceDigest && sourceChanges.fromSourceDigest === parent.sourceDigest
    && sourceChanges.toSourceDigest === sourceDigest && sourceChanges.parentRunId === parent.runId
    && sourceChanges.snapshotEvidenceRef && Array.isArray(sourceChanges.changedPaths)
    && sourceChanges.changedPaths.length > 0 && sourceChanges.changedPaths.every(path => typeof path === 'string' && path.length > 0)
    && sourceChanges.changeDigest === digestJson({ fromSourceDigest: sourceChanges.fromSourceDigest,
      toSourceDigest: sourceChanges.toSourceDigest, changedPaths: sourceChanges.changedPaths,
      snapshotEvidenceRef: sourceChanges.snapshotEvidenceRef, parentRunId: sourceChanges.parentRunId }),
  'REPLAN_SOURCE_CHANGE_INVALID', 'Source change basis does not bind the parent and current workspace snapshots.');
  assert(changeRequest || snapshot.reviewApproved === false || sourceChanges,
    'REPLAN_SOURCE_EVIDENCE_REQUIRED', 'A source-only plan revision requires a verified file delta from the prior plan snapshot.');
  const revisionBasis = [
    ...(changeRequest ? [{ kind: 'registered-change-request', id: changeRequest.id, digest: changeRequest.digest }] : []),
    ...(snapshot.reviewApproved === false ? [{ kind: 'rejected-plan-review', parentRunId: parent.runId,
      authorityDigest: parent.authorityDigest, findingsDigest: digestJson([...parent.submissions].reverse().find(submission => submission.result?.outputs?.['plan-review'])?.result.outputs['plan-review'].value.findings ?? []) }] : []),
    ...(sourceChanges ? [{ kind: 'verified-source-delta', ...structuredClone(sourceChanges) }] : []),
  ];
  const implementationRuns = states.filter(state => !['closed', 'superseded'].includes(state.status)
    && state.metadata?.commandIntent?.target === intent.target
    && state.metadata?.workflow?.id === intent.workflowId
    && state.features.some(feature => feature.metadata?.stage === 'implementation'));
  assert(implementationRuns.every(state => !state.leases.some(lease => lease.status === 'active')
    && !state.dispatches.some(dispatch => ['requested', 'assigned'].includes(dispatch.status))),
  'REPLAN_IMPLEMENTATION_BUSY', 'Active implementation work must reach an idle boundary before replanning.');
  assert(implementationRuns.every(state => !state.findings?.some(finding => finding.status !== 'resolved')),
    'REPLAN_OPEN_FINDINGS', 'Open implementation findings require evidence-backed resolution before the Run can be retired for replanning.');
  if (intent.action === 'amend') {
    const completed = new Set(implementationRuns.flatMap(state => [
      ...(state.metadata?.approvedPlan?.amendmentBaseline?.completedProposalIds ?? []),
      ...state.features.filter(feature => feature.state === 'completed'
        && (!feature.metadata?.deliveryBatch || feature.metadata.deliveryBatch.phase === 'convergence'))
        .map(feature => feature.metadata?.approvedProposal?.id),
    ]));
    assert((amendmentScope ?? declaration.amendmentScope).featureSplits?.every(item => !completed.has(item.featureId)) ?? true,
      'PLAN_AMENDMENT_COMPLETED_SPLIT_DENIED', 'A split cannot reopen an already completed proposal.');
  }
  return {
    ...intent,
    ...(changeRequest ? { changeRequest } : {}),
    planRevision: {
      parentRunId: parent.runId,
      parentAuthorityDigest: parent.authorityDigest,
      parentPlanDigest: snapshot.planDigest,
      parentArtifactDigest: snapshot.artifactDigest,
      parentSourceDigest: parent.sourceDigest,
      parentReviewApproved: snapshot.reviewApproved,
      parentPlan: previousPlan,
      parentReviewFindings: [...parent.submissions].reverse().find(submission => submission.result?.outputs?.['plan-review'])?.result.outputs['plan-review'].value.findings ?? [],
      ...(intent.action === 'amend' ? { amendmentScope: structuredClone(amendmentScope ?? declaration.amendmentScope),
        changeRequestDigest: changeRequest.digest } : {}),
      ...(replacesAmendment ? { replacesAmendment } : {}),
      revisionBasis,
      affectedImplementationRuns: implementationRuns.map(state => ({ runId: state.runId, revision: state.revision, authorityDigest: state.authorityDigest })),
    },
  };
};

