import { digestJson, withoutKeys } from '../common/canonical.mjs';
import { assert } from '../common/errors.mjs';

/** Keep the sealed Feature approval context after freshly validating approval. */
export const resolveCarryoverApproval = ({ input, currentApproval, prior }) => {
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
  const original = prior.metadata.approvedPlan;
  // Source compatibility is re-assessed at every start. It is provenance, not
  // a new approval or permission to rewrite the sealed implementation graph.
  const identity = value => withoutKeys(value, ['sourceDigest', 'sourceCompatibility']);
  assert(original && currentApproval && digestJson(identity(original)) === digestJson(identity(currentApproval)),
    'CARRYOVER_APPROVAL_IDENTITY_CHANGED', 'Current approval differs from the original approved plan or user Decision.');
  return structuredClone(original);
};
