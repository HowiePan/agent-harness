import { digestJson, withoutKeys } from '../common/canonical.mjs';
import { assert } from '../common/errors.mjs';

const assertCarryoverClaim = (input, prior) => {
  const claim = prior?.metadata?.completionCarryover;
  assert(prior?.status === 'superseded' && prior.projectId === input.projectId
    && prior.runId === input.completionCarryover?.priorRunId
    && prior.metadata.supersededByRunId === input.runId
    && prior.metadata.supersedePlanDigest === input.metadata?.lifecyclePlanDigest
    && claim?.plan?.carryoverDigest === input.completionCarryover?.carryoverDigest
    && claim.plan.replacementRunId === input.runId
    && claim.plan.replacementPlanDigest === input.metadata.lifecyclePlanDigest
    && claim.plan.sourceDigest === input.sourceDigest && prior.sourceDigest === input.sourceDigest,
  'CARRYOVER_APPROVAL_CLAIM_MISMATCH', 'Approval context requires the exact sealed replacement and source.');
};

/** Revalidate amendment inheritance at the original approved start, not after implementation edits. */
export const readCarryoverApprovalSnapshot = async ({ input, prior, currentSnapshot, authorityStore, evidenceStore }) => {
  assertCarryoverClaim(input, prior);
  assert(currentSnapshot?.digest === input.sourceDigest,
    'CARRYOVER_WORKSPACE_SOURCE_STALE', 'Current source must still match the sealed replacement.');
  const approval = prior.metadata.approvedPlan;
  assert(approval?.sourceDigest, 'CARRYOVER_APPROVAL_SOURCE_EVIDENCE_REQUIRED', 'Original approval source is missing.');
  let origin = prior;
  const visited = new Set();
  while (!origin.dispatches?.some(item => item.sourceDigest === approval.sourceDigest && item.sourceSnapshotRef)) {
    const link = [...(origin.events ?? [])].reverse().find(item => item.type === 'feature.completion-carried-over');
    assert(link?.priorRunId && !visited.has(origin.runId),
      'CARRYOVER_APPROVAL_SOURCE_EVIDENCE_REQUIRED', 'Original approval snapshot has no verified carry-over origin.');
    visited.add(origin.runId);
    const parent = await authorityStore.read(input.projectId, link.priorRunId);
    const claim = parent.metadata?.completionCarryover?.plan;
    assert(parent.projectId === input.projectId && parent.status === 'superseded'
      && parent.metadata.supersededByRunId === origin.runId
      && parent.metadata.supersedePlanDigest === origin.metadata?.lifecyclePlanDigest
      && claim?.replacementRunId === origin.runId && claim.replacementPlanDigest === origin.metadata.lifecyclePlanDigest
      && claim.carryoverDigest === link.carryoverDigest,
    'CARRYOVER_APPROVAL_SOURCE_EVIDENCE_INVALID', 'Approval source carry-over lineage changed.');
    origin = parent;
  }
  const dispatch = origin.dispatches.find(item => item.sourceDigest === approval.sourceDigest && item.sourceSnapshotRef);
  const record = await evidenceStore.read(dispatch.sourceSnapshotRef);
  const snapshot = JSON.parse(record.bytes.toString('utf8'));
  const metadata = record.metadata;
  assert(metadata.ref === dispatch.sourceSnapshotRef && metadata.projectId === input.projectId
    && metadata.runId === origin.runId && metadata.sourceDigest === approval.sourceDigest
    && metadata.epoch === dispatch.epoch && metadata.generation === dispatch.generation
    && metadata.featureId === null && metadata.dispatchId === null
    && metadata.labels?.includes('workspace-snapshot') && metadata.mediaType === 'application/json'
    && snapshot.protocolVersion === '1.0' && snapshot.root === currentSnapshot.root
    && Array.isArray(snapshot.files) && snapshot.digest === digestJson(snapshot.files)
    && snapshot.digest === approval.sourceDigest,
  'CARRYOVER_APPROVAL_SOURCE_EVIDENCE_INVALID', 'Original approval snapshot is not bound to its source, project and Dispatch.');
  return snapshot;
};

/** Keep the sealed Feature approval context after freshly validating approval. */
export const resolveCarryoverApproval = ({ input, currentApproval, prior }) => {
  assertCarryoverClaim(input, prior);
  const original = prior.metadata.approvedPlan;
  // Source compatibility is re-assessed at every start. It is provenance, not
  // a new approval or permission to rewrite the sealed implementation graph.
  const identity = value => withoutKeys(value, ['sourceDigest', 'sourceCompatibility']);
  assert(original && currentApproval && digestJson(identity(original)) === digestJson(identity(currentApproval)),
    'CARRYOVER_APPROVAL_IDENTITY_CHANGED', 'Current approval differs from the original approved plan or user Decision.');
  return structuredClone(original);
};
