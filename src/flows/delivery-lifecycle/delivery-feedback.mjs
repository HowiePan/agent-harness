import { isIncompleteImplementationResult } from '../../common/implementation-result.mjs';

const incompleteHandoff = result => (isIncompleteImplementationResult(result)
  || result?.status === 'blocked' && result.failureClass === 'implementation-incomplete'
    && ['context-limit', 'context-capacity'].includes(result.blocker?.kind))
  && !(result.observations ?? []).some(item => item.startsWith('Host verification evidence:'));

export const deliveryBatchFeedback = (state, feature) => {
  if (!feature.metadata?.deliveryBatch) return null;
  const history = state.submissions.filter(item => {
    const bound = state.dispatches?.find(dispatch => dispatch.dispatchId === item.dispatchId)?.execution?.implementationContinuation?.workBatch;
    return item.featureId === feature.id && !item.supersededAt && item.evidenceRefs?.length
      && bound?.policy === feature.metadata.deliveryBatch.policy
      && bound.planDigest === feature.metadata.deliveryBatch.planDigest && bound.id === feature.metadata.deliveryBatch.id;
  });
  const unplannedHandoffs = history.filter(item => incompleteHandoff(item.result));
  return { policy: 'bounded-delivery-feedback/1', unplannedHandoffs: unplannedHandoffs.length,
    maxUnplannedHandoffsBeforeReview: 3, repairReserve: feature.metadata.deliveryOwnerProposal.deliveryBatchReserve,
    priorSubmissionIds: unplannedHandoffs.map(item => item.submissionId),
    sizingReviewSuggested: unplannedHandoffs.length >= 2,
    instruction: 'Finish the coherent planned batch; repeated voluntary slices require a bounded sizing/strategy review, not a bigger Agent task. Observed check failures, external blocks and provider interruptions retain their own repair/budget rules.' };
};

export const classifyFragmentedDeliveryHandoff = (state, feature, result) => {
  const feedback = deliveryBatchFeedback(state, feature);
  if (!feedback || !incompleteHandoff(result) || feedback.unplannedHandoffs + 1 < feedback.maxUnplannedHandoffsBeforeReview) return result;
  return { ...result, failureClass: 'implementation-sizing-review',
    summary: `Three unplanned incomplete handoffs in the same approved batch require sizing/strategy review. ${result.summary}`,
    blocker: { kind: 'delivery-sizing-review', summary: 'Repeated partial delivery deviates from the approved moderate batch.',
      resumeWhen: 'Review actual scope, cohesion and context cost; use a bounded amendment if batch sizing must change. Do not force the remainder into one giant Agent or restart full Replan.' },
    observations: [...(result.observations ?? []), `Prior partial Submissions: ${feedback.priorSubmissionIds.join(', ')}`] };
};
