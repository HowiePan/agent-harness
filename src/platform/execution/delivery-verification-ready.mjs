import { digestJson } from '../../common/canonical.mjs';
import { assert } from '../../common/errors.mjs';

export const DELIVERY_VERIFICATION_HANDOFF = 'delivery-verification-ready/1';

/** A native implementation candidate is not a completion or a Kernel result. */
export const assertVerificationReady = (result, feature) => {
  const batch = feature?.metadata?.deliveryBatch;
  const request = result.verificationRequest;
  const ids = batch?.obligationIds ?? [];
  assert(batch?.policy === 'bounded-delivery/2' && batch?.checks?.length && ids.length
    && digestJson(Object.keys(feature.metadata.outputPorts ?? {}).sort()) === digestJson(['implement'])
    && feature.metadata.outputPorts.implement === 'delivery-implementation-v1'
    && result.status === 'verification-ready'
    && request?.version === DELIVERY_VERIFICATION_HANDOFF
    && request.batchDigest === feature.metadata.deliveryPlanBinding?.batchDigest
    && request.batchDigest === digestJson(Object.fromEntries(Object.entries(batch).filter(([key]) => !['policy', 'planDigest'].includes(key))))
    && digestJson(request.checkIds) === digestJson(batch.checks.map(check => check.id))
    && !Object.keys(result.outputs ?? {}).length && !result.failureClass && !result.blocker
    && !(result.deliveryPrerequisites?.length || result.findings?.length || result.followUpFeatures?.length),
  'DELIVERY_VERIFICATION_REQUEST_INVALID', 'Verification readiness requires the exact enabled delivery and checks, without completion outputs or unresolved blockers.');
  for (const id of ids) {
    const matches = (result.checkpoints ?? []).filter(item => item.id === id);
    assert(matches.length === 1 && matches[0].status === 'implemented' && matches[0].evidence?.length
      && batch.checks.some(check => check.covers.includes(id)),
    'DELIVERY_VERIFICATION_READINESS_INCOMPLETE', 'Every assigned obligation needs implementation evidence and an approved Host check.');
  }
  return result;
};

/** Only successful current Host receipts can turn a candidate into acceptance. */
export const completeVerifiedDelivery = (native, feature, receipts, approvedChecks = feature.metadata.deliveryBatch.checks) => {
  assertVerificationReady(native, feature);
  const batch = feature.metadata.deliveryBatch;
  assert(batch.checks.every(check => approvedChecks.some(item => digestJson(item) === digestJson(check)))
    && receipts.length === approvedChecks.length && receipts.every(item => item.status === 'passed' && !item.sourceDrift && item.evidenceRef)
    && approvedChecks.every(check => {
      const matches = receipts.filter(item => digestJson(item.approvedCheck) === digestJson(check));
      return matches.length === 1 && matches[0].check?.id === check.id
        && digestJson(matches[0].check.covers) === digestJson(check.covers);
    })
    && batch.obligationIds.every(id => receipts.some(item => item.check.covers.includes(id))),
  'DELIVERY_VERIFICATION_RECEIPTS_REQUIRED', 'All approved checks must pass with bound Host evidence before completion.');
  const refs = [...new Set(receipts.map(item => item.evidenceRef))];
  const proposal = feature.metadata.approvedProposal;
  const { verificationRequest: _request, ...result } = native;
  return { ...result, status: 'completed',
    summary: `Host verification accepted delivery ${batch.id}. ${native.summary}`,
    checkpoints: result.checkpoints.map(item => batch.obligationIds.includes(item.id)
      ? { ...item, status: 'completed', evidence: [...new Set([...item.evidence,
        ...receipts.filter(receipt => receipt.check.covers.includes(item.id)).map(receipt => receipt.evidenceRef)])] } : item),
    outputs: { implement: { schemaId: 'delivery-implementation-v1', evidenceRefs: refs, value: {
      proposalId: proposal.id, changedFiles: [...native.changedFiles], completedContracts: structuredClone(proposal.contracts ?? []),
      verificationResults: (proposal.verification ?? []).map(item => ({ item, status: 'completed', evidenceRefs: refs })),
    } } },
  };
};
