import {digestJson} from '../common/canonical.mjs';
import {submissionAttempt} from '../kernel/attempt-budget.mjs';
import {executionBudgetBlocked} from '../common/continuous-execution.mjs';
import {processFailureRecovery} from './execution-fault.mjs';

// A failed deterministic check is work for its existing owner. This grants no
// completion credit, external authority, diagnostic allowance or extra attempts.
export const inspectDeliveryFailureRetries = async (state,evidenceStore) => {
  if(state.metadata?.projectFilePolicy?.mode!=='project-owned'||state.metadata?.operatorStop?.requested)return [];
  const output=[];
  for(const feature of state.features.filter(f=>f.state==='blocked'&&f.metadata?.stage==='implementation'&&f.metadata?.deliveryBatch)){
    const submission=state.submissions.findLast(s=>s.featureId===feature.id&&!s.supersededAt);
    const attempt=submission&&submissionAttempt(state,feature,submission);
    if(!attempt||attempt.exhausted||executionBudgetBlocked(state,feature)
      ||submission.result.status!=='blocked'||submission.result.failureClass!=='environment'||submission.result.blocker?.kind!=='environment')continue;
    let ref=null;
    for(const evidenceRef of submission.evidenceRefs){
      const saved=await evidenceStore.read(evidenceRef),value=JSON.parse(saved.bytes.toString('utf8'));
      const checks=value.runtimeEvidence?.deliveryVerification??[];
      ref=checks.find(c=>['environment-failed','budget-exceeded'].includes(c.status))?.evidenceRef??null;
      if(ref)break;
    }
    // Read-only compatibility for already committed pre-structured results.
    ref??=submission.result.blocker.resumeWhen?.match(/evidence:[a-f0-9]{64}:[a-f0-9]{64}/)?.[0];
    if(!ref)continue;
    const record=await evidenceStore.read(ref),receipt=JSON.parse(record.bytes.toString('utf8'));
    const host=receipt.executorReceipt?.payload;
    if(record.metadata.projectId!==state.projectId||record.metadata.featureId!==feature.id
      ||record.metadata.dispatchId!==submission.dispatchId||record.metadata.sourceDigest!==submission.outputSourceDigest
      ||receipt.kind!=='delivery-verification-receipt'||!['environment-failed','budget-exceeded'].includes(receipt.status)||receipt.cacheHit!==false||receipt.sourceDrift!==false
      ||receipt.sourceBefore!==submission.outputSourceDigest||receipt.sourceAfter!==submission.outputSourceDigest
      ||!feature.metadata.deliveryBatch.checks.some(check=>digestJson(check)===digestJson(receipt.approvedCheck))
      ||host?.resourceReceipt?.supervised!==true
      ||(receipt.recovery?.version==='verification-recovery/1'?receipt.recovery.operation:processFailureRecovery(receipt))!=='owner-repair')continue;
    output.push({kind:'delivery-failure-retry',featureId:feature.id,submissionDigest:submission.submissionDigest,
      sourceDigest:state.sourceDigest,evidenceRef:ref,checkId:receipt.approvedCheck.id});
  }
  return output;
};
