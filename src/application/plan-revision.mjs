import { digestJson } from '../common/canonical.mjs';
import { assert } from '../common/errors.mjs';
import { planApprovalSnapshot } from '../flows/delivery-lifecycle/plan-approval.mjs';
export { diffPlanFeatures } from '../flows/delivery-lifecycle/plan-diff.mjs';

const planOutput = state => {
  const ids = new Set(state.features.filter(feature => feature.metadata?.stage === 'version-planning').map(feature => feature.id));
  return [...state.submissions].reverse().find(submission => ids.has(submission.featureId)
    && submission.result?.status === 'completed' && !submission.supersededAt)?.result.outputs?.plan?.value ?? null;
};

export const preparePlanRevisionIntent = ({ intent, project, states, sourceDigest }) => {
  if (intent.action !== 'replan') return intent;
  const candidates = states.filter(state => state.status !== 'superseded'
    && ['plan', 'replan'].includes(state.metadata?.commandIntent?.action)
    && state.metadata.commandIntent.target === intent.target
    && state.metadata.commandIntent.workflowId === intent.workflowId
    && state.features.some(feature => feature.metadata?.stage === 'plan-review'));
  const parent = candidates.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0];
  assert(parent, 'REPLAN_PARENT_REQUIRED', 'Replan requires an existing plan for the same project, workflow, and target.');
  const snapshot = planApprovalSnapshot(parent);
  const previousPlan = planOutput(parent);
  assert(snapshot && previousPlan, 'REPLAN_PARENT_INCOMPLETE', 'Replan requires a completed prior plan and independent review.');
  const declaration = intent.selector ? project.policy?.planChangeRequests?.[intent.selector] : null;
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
  const implementationRuns = states.filter(state => !['closed', 'superseded'].includes(state.status)
    && state.metadata?.commandIntent?.target === intent.target
    && state.metadata?.workflow?.id === intent.workflowId
    && state.features.some(feature => feature.metadata?.stage === 'implementation'));
  assert(implementationRuns.every(state => !state.leases.some(lease => lease.status === 'active')
    && !state.dispatches.some(dispatch => ['requested', 'assigned'].includes(dispatch.status))),
  'REPLAN_IMPLEMENTATION_BUSY', 'Active implementation work must reach an idle boundary before replanning.');
  assert(implementationRuns.every(state => !state.findings?.some(finding => finding.status !== 'resolved')),
    'REPLAN_OPEN_FINDINGS', 'Open implementation findings require evidence-backed resolution before the Run can be retired for replanning.');
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
      affectedImplementationRuns: implementationRuns.map(state => ({ runId: state.runId, revision: state.revision, authorityDigest: state.authorityDigest })),
    },
  };
};

