import { digestJson } from '../common/canonical.mjs';
import { assert } from '../common/errors.mjs';
import { captureWorkspace } from '../common/workspace-snapshot.mjs';
import { submissionAttempt } from '../kernel/attempt-budget.mjs';
import { resolveVerificationInputs } from './verification-input-bindings.mjs';

export const INPUT_BINDING_BLOCKER = 'delivery-check-input-rebinding-required';
const decisionId = feature => `verification-input-repair/${digestJson(feature.id)}`;

/** Read-only proof. A blocker label alone never authorizes a retry. */
export const inspectVerificationInputRepairs = async (state, workspaceRoot, excluded = []) => {
  const repairs = [];
  for (const feature of state.features) {
    const submission = state.submissions.findLast(item => item.featureId === feature.id && !item.supersededAt);
    const recorded = state.decisions?.find(item => item.id === decisionId(feature));
    if (feature.state !== 'blocked' || feature.metadata?.stage !== 'implementation'
      || submission?.result?.status !== 'blocked' || submission.result.failureClass !== 'external-blocker'
      || submission.result.blocker?.kind !== 'prerequisite'
      || submission.result.blocker.code !== INPUT_BINDING_BLOCKER
      || !submission.evidenceRefs?.length || submission.outputSourceDigest !== state.sourceDigest
      || (recorded && recorded.submissionId !== submission.submissionId)
      || state.leases?.some(item => item.featureId === feature.id && item.status === 'active')
      || state.dispatches?.some(item => item.featureId === feature.id && ['requested', 'assigned', 'bound'].includes(item.status))
      || !submissionAttempt(state, feature, submission) || submissionAttempt(state, feature, submission).exhausted) continue;
    const checks = feature.metadata.deliveryBatch?.checks;
    if (!checks?.length) continue;
    const resolutions = await Promise.all(checks.map(check => resolveVerificationInputs({ check, workspaceRoot,
      allowedPaths: feature.allowedPaths, forbiddenPaths: feature.forbiddenPaths, excluded,
      projectFilePolicy:state.metadata.projectFilePolicy,continuousExecution:state.metadata.continuousExecution })));
    if (resolutions.some(item => item.missingInputs.length) || !resolutions.some(item => item.bindings.length)) continue;
    const repair = { kind: 'verification-input-repair', version: '1.0.0', featureId: feature.id,
      submissionId: submission.submissionId, sourceDigest: state.sourceDigest,
      approvedChecksDigest: digestJson(checks), decisionId: decisionId(feature), resolutions };
    if (recorded && !(recorded.kind === repair.kind && recorded.actor === 'harness' && recorded.decision === 'verified'
      && recorded.featureId === feature.id && recorded.sourceDigest === repair.sourceDigest
      && recorded.approvedChecksDigest === repair.approvedChecksDigest && recorded.bindingDigest === digestJson(resolutions))) continue;
    repairs.push(repair);
  }
  return repairs;
};

export const applyVerificationInputRepair = async ({ state, featureId, project, kernel, evidenceStore, commandId }) => {
  const workspaceRoot = state.metadata?.workspace?.root ?? project.workspace.root;
  const excluded = project.workspace.excluded ?? [];
  const repair = (await inspectVerificationInputRepairs(state, workspaceRoot, excluded)).find(item => item.featureId === featureId);
  if (!repair) return null;
  const snapshot = await captureWorkspace(workspaceRoot, { excluded });
  assert(snapshot.digest === state.sourceDigest, 'WORKSPACE_SOURCE_DRIFT', 'Input binding repair cannot admit uncommitted source drift.');
  const existing = state.decisions?.find(item => item.id === repair.decisionId);
  if (existing) {
    const evidence = await evidenceStore.read(existing.evidenceRef);
    assert(evidence.metadata.projectId === state.projectId && evidence.metadata.runId === state.runId
      && evidence.metadata.epoch === state.epoch && evidence.metadata.generation === state.generation
      && evidence.metadata.featureId === featureId && digestJson(JSON.parse(evidence.bytes.toString('utf8'))) === digestJson(repair),
    'VERIFICATION_INPUT_REPAIR_EVIDENCE_STALE', 'Recovery requires the original verified input binding proof.');
  }
  const proof = existing ? { ref: existing.evidenceRef } : await evidenceStore.put(repair, { projectId: state.projectId, runId: state.runId,
    epoch: state.epoch, generation: state.generation, artifactDigest: state.artifactDigest, policyDigest: state.policyDigest,
    featureId, sourceDigest: state.sourceDigest, mediaType: 'application/json', labels: ['verification-input-repair'] });
  const recorded = existing ? { state } : await kernel.recordDecision(state.projectId, state.runId, { id: repair.decisionId,
    kind: repair.kind, version: repair.version, actor: 'harness', decision: 'verified',
    featureId, submissionId: repair.submissionId, sourceDigest: repair.sourceDigest,
    approvedChecksDigest: repair.approvedChecksDigest, bindingDigest: digestJson(repair.resolutions), evidenceRef: proof.ref },
  { expectedRevision: state.revision, commandId: `${commandId}.binding-proof` });
  return kernel.reopenFeature(state.projectId, state.runId, { featureId,
    reason: `Verified manifest-bound input correction; original plan, command, obligations, source scope and budgets unchanged. Proof: ${proof.ref}` },
  { expectedRevision: recorded.state.revision, commandId: `${commandId}.binding-reopen` });
};
