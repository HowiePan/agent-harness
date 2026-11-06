import { assert } from '../common/errors.mjs';
import { digestJson, withoutKeys } from '../common/canonical.mjs';
import { planApprovalSnapshot, planApprovalSatisfied } from '../flows/delivery-lifecycle/plan-approval.mjs';
import { readPlanAmendmentScope } from './plan-amendment-artifacts.mjs';
import { createLifecycleCommandPlan } from './lifecycle-command-plan.mjs';
import { deriveQualityTargetSnapshot } from '../platform/execution/quality-target.mjs';
import { sealLegacyFindingInventory } from '../platform/execution/known-finding-inventory.mjs';
import { isBoundIntervention } from './interruption-review.mjs';

/** An interrupted replacement may fail before reading its immutable input. */
export const interruptedAmendmentTransportDraft = state => {
  const ref = state.metadata?.planRevision?.recoveryDraft;
  const primary = state.features.filter(row => row.metadata?.stage === 'version-planning');
  if (state.metadata?.commandIntent?.action !== 'amend' || !['ready', 'superseded'].includes(state.status)
    || state.status === 'superseded' && !/^development-h[23]-recovery:[a-f0-9]{64}$/.test(state.metadata?.supersededReason ?? '')
    || ref?.kind !== 'interrupted-amendment-review/1' || ref.sourceDigest !== state.sourceDigest
    || ref.acceptance !== 'unaccepted-requires-planning-and-review'
    || !/^[a-f0-9]{64}$/.test(ref.submissionDigest ?? '') || !ref.evidenceRefs?.length
    || primary.length !== 1 || primary[0].state !== 'blocked'
    || state.features.some(row => !['version-planning', 'plan-review'].includes(row.metadata?.stage) && !isBoundIntervention(state, row))
    || state.features.some(row => row.metadata?.stage === 'plan-review' && row.state !== 'pending')
    || state.findings?.some(row => row.status !== 'resolved')
    || state.decisions?.some(row => row.id === 'implementation-plan-approved' && row.decision === 'approved')
    || state.leases.some(row => row.status === 'active')
    || state.dispatches.some(row => ['requested', 'assigned'].includes(row.status))
    || !state.submissions.some(row => row.featureId === primary[0].id && row.result?.blocker?.kind === 'input')
    || state.submissions.some(row => row.changedFiles?.length || row.result?.status !== 'blocked'
      || row.inputSourceDigest !== state.sourceDigest || row.outputSourceDigest !== state.sourceDigest
      || row.submissionDigest !== digestJson(withoutKeys(row, ['submissionDigest']))
      || !state.dispatches.some(dispatch => dispatch.dispatchId === row.dispatchId && dispatch.status === 'committed'
        && dispatch.submissionId === row.submissionId))) return null;
  return { transportFailure: true, originRunId: ref.priorRunId, deltaRef: structuredClone(ref.deltaRef),
    planner: { submissionId: ref.submissionId, submissionDigest: ref.submissionDigest, evidenceRefs: [...ref.evidenceRefs] } };
};

/** A committed candidate is reusable draft input, never inherited plan approval. */
export const interruptedAmendmentReviewDraft = state => {
  if (state.metadata?.commandIntent?.action !== 'amend'
    || !['running', 'superseded'].includes(state.status)
    || state.status === 'superseded' && !/^development-h[23]-recovery:[a-f0-9]{64}$/.test(state.metadata?.supersededReason ?? '')
    || state.decisions?.some(row => row.id === 'implementation-plan-approved' && row.decision === 'approved')
    || state.findings?.some(row => row.status !== 'resolved')
    || state.features.some(row => !['version-planning', 'plan-review'].includes(row.metadata?.stage))) return null;
  const running = state.features.filter(row => row.state === 'running');
  if (running.length !== 1 || running[0].metadata.stage !== 'plan-review' || running[0].allowedPaths.length) return null;
  const review = running[0];
  if (state.submissions.some(row => !row.supersededAt && row.featureId === review.id)) return null;
  const planners = state.submissions.filter(row => !row.supersededAt && row.result?.status === 'completed'
    && state.features.some(feature => feature.id === row.featureId && feature.metadata.stage === 'version-planning'
      && feature.state === 'completed' && feature.submissionId === row.submissionId));
  const planner = planners.at(-1), revision = state.metadata.planRevision;
  const delta = planner?.result.outputs?.amendment?.value;
  if (!planner || !revision || delta?.version !== 'plan-amendment/1' || delta.plan
    || delta.basePlanDigest !== revision.parentPlanDigest || delta.changeRequestDigest !== revision.changeRequestDigest
    || !delta.deltaRef?.path?.startsWith(`${revision.amendmentScope.artifactRoot}/`)
    || !/^[a-f0-9]{64}$/.test(delta.deltaRef.sha256 ?? '')
    || planner.outputSourceDigest !== state.sourceDigest || !planner.evidenceRefs?.length
    || planner.submissionDigest !== digestJson(withoutKeys(planner, ['submissionDigest']))
    || !state.dispatches.some(row => row.dispatchId === planner.dispatchId && row.status === 'committed'
      && row.submissionId === planner.submissionId)) return null;
  const leases = state.leases.filter(row => row.featureId === review.id
    && row.status === (state.status === 'superseded' ? 'superseded' : 'active'));
  if (leases.length !== 1 || !state.dispatches.some(row => row.dispatchId === leases[0].dispatchId
    && row.featureId === review.id && row.status === (state.status === 'superseded' ? 'superseded' : 'assigned'))) return null;
  return { planner, review, deltaRef: structuredClone(delta.deltaRef) };
};

export const amendmentReviewRecoveryIntent = ({ state, project, snapshot, patchReceiptDigest }) => {
  const draft = interruptedAmendmentReviewDraft(state) ?? interruptedAmendmentTransportDraft(state);
  const fail = condition => assert(condition, 'DEVELOPMENT_AMENDMENT_REVIEW_RECOVERY_UNSAFE',
    'Review recovery requires the unchanged, unapproved committed candidate, request and implementation ancestry.');
  const original = state.metadata?.commandIntent;
  const revision = state.metadata?.planRevision;
  fail(draft && snapshot.digest === state.sourceDigest && snapshot.root === state.metadata.workspace.root
    && snapshot.digest === digestJson(snapshot.files) && /^[a-f0-9]{64}$/.test(patchReceiptDigest ?? '')
    && project.id === state.projectId
    && digestJson(project.policy?.planChangeRequests?.[original.selector] ?? null) === revision.changeRequestDigest
    && digestJson(original.planRevision) === digestJson(revision));
  const intent = structuredClone(original);
  intent.planRevision.recoveryDraft = { kind: 'interrupted-amendment-review/1', priorRunId: draft.originRunId ?? state.runId,
    retiredRunId: state.runId,
    patchReceiptDigest, sourceDigest: state.sourceDigest, submissionId: draft.planner.submissionId,
    submissionDigest: draft.planner.submissionDigest, evidenceRefs: [...draft.planner.evidenceRefs], deltaRef: draft.deltaRef,
    acceptance: 'unaccepted-requires-planning-and-review' };
  for (const baseline of intent.planRevision.implementationBaselines ?? []) {
    fail(!(baseline.retirementChain ?? []).includes(state.runId));
    baseline.retirementChain = [...(baseline.retirementChain ?? []), state.runId];
  }
  return intent;
};

export const createAmendmentReviewRecoveryPlan = async ({ state, project, snapshot, patchReceiptDigest,
  authorityStore, evidenceStore = null, extension, releaseIdentity, executionConstraintDigest, sourceToolBinding = null }) => {
  const intent = amendmentReviewRecoveryIntent({ state, project, snapshot, patchReceiptDigest });
  const transport = interruptedAmendmentTransportDraft(state);
  if (transport) {
    const origin = await authorityStore.read(project.id, transport.originRunId);
    const original = interruptedAmendmentReviewDraft(origin);
    assert(origin.status === 'superseded' && original && evidenceStore
      && original.planner.submissionId === transport.planner.submissionId
      && original.planner.submissionDigest === transport.planner.submissionDigest
      && digestJson(original.planner.evidenceRefs) === digestJson(transport.planner.evidenceRefs)
      && digestJson(original.deltaRef) === digestJson(transport.deltaRef)
      && origin.sourceDigest === snapshot.digest,
    'DEVELOPMENT_AMENDMENT_REVIEW_ORIGIN_CHANGED', 'Transport recovery requires the exact committed draft origin and Evidence.');
    const { verifyBlockedDraftArtifacts } = await import('./plan-amendment-draft-artifacts.mjs');
    await verifyBlockedDraftArtifacts({ drafts: [origin], snapshot, evidenceStore,
      artifactRoot: origin.metadata.planRevision.amendmentScope.artifactRoot });
  }
  const revision = intent.planRevision;
  const base = await authorityStore.read(project.id, revision.parentRunId);
  const approval = planApprovalSnapshot(base);
  assert(base.status === 'closed' && planApprovalSatisfied(base)
    && base.authorityDigest === revision.parentAuthorityDigest && approval?.planDigest === revision.parentPlanDigest,
  'DEVELOPMENT_AMENDMENT_REVIEW_BASE_CHANGED', 'The original approved base changed.');
  const scope = await readPlanAmendmentScope(project.policy.planChangeRequests[intent.selector], snapshot.root);
  assert(digestJson(scope) === digestJson(revision.amendmentScope),
    'DEVELOPMENT_AMENDMENT_REVIEW_SCOPE_CHANGED', 'Registered scope or document pins changed during recovery.');
  if (intent.qualityTarget) {
    const declaration = project.policy?.knownFindingInventories?.[intent.target];
    // This candidate has no review result or Findings. Exclude its changing
    // transport status from both derivations; all other quality evidence stays.
    intent.qualityTarget = deriveQualityTargetSnapshot({ projectId: project.id, workflowId: intent.workflowId,
      target: intent.target, sourceDigest: snapshot.digest,
      runs: (await authorityStore.list(project.id)).filter(row => row.runId !== state.runId),
      legacyInventory: declaration ? sealLegacyFindingInventory({ projectId: project.id, target: intent.target, declaration }) : null,
      findingScopePaths: project.policy?.qualityFindingPaths ?? [] });
  }
  const plan = createLifecycleCommandPlan({ intent, project, extension, releaseIdentity,
    sourceDigest: snapshot.digest, executionWorkspaceRoot: snapshot.root,
    workspaceIdentity: state.metadata.workspace.identity,
    executionConstraintDigest, sourceToolBinding, compiler: extension.operations?.createLifecyclePlan });
  if (state.status === 'superseded') assert(state.metadata.supersededByRunId === plan.run.runId
    && state.metadata.supersedePlanDigest === plan.planDigest,
  'DEVELOPMENT_AMENDMENT_REVIEW_PLAN_STALE', 'The pending recovery Plan no longer matches current identities.');
  return plan;
};
