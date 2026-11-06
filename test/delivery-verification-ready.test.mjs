import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from './delivery-batch-support.mjs';
import { digestJson } from '../src/common/canonical.mjs';
import { assertVerificationReady, completeVerifiedDelivery, DELIVERY_VERIFICATION_HANDOFF } from '../src/platform/execution/delivery-verification-ready.mjs';
import { validateBusinessResult } from '../src/platform/execution/result-contract.mjs';
import { verifyDeliveryBatchResult } from '../src/application/delivery-verification.mjs';

const fixture = () => {
  const feature = compile()[0];
  const batch = feature.metadata.deliveryBatch;
  const result = { status: 'verification-ready', summary: 'Implementation ready; original checks not yet executed.', changedFiles: ['src/receiver.mjs'],
    verificationRequest: { version: DELIVERY_VERIFICATION_HANDOFF, batchDigest: feature.metadata.deliveryPlanBinding.batchDigest,
      checkIds: batch.checks.map(check => check.id) },
    checkpoints: batch.obligationIds.map(id => ({ id, status: 'implemented', summary: 'Receiver and consumer implemented.', evidence: ['src/receiver.mjs'] })) };
  const receipts = batch.checks.map(check => ({ approvedCheck: check, check, status: 'passed', sourceDrift: false, evidenceRef: `evidence:${digestJson(check)}` }));
  return { feature, result, receipts };
};

test('native readiness is not a Kernel completion; successful Host evidence derives a separately validated result', () => {
  const {feature, result, receipts} = fixture();
  const before = digestJson(result);
  assert.throws(() => validateBusinessResult(result, { conversationVisible: true, feature }), { code: 'RESULT_VERIFICATION_REQUEST_UNRESOLVED' });
  validateBusinessResult(result, { conversationVisible: true, feature, allowVerificationReady: true });
  const accepted = completeVerifiedDelivery(result, feature, receipts);
  assert.equal(digestJson(result), before);
  assert.equal(accepted.status, 'completed');
  assert.equal(accepted.verificationRequest, undefined);
  assert(accepted.checkpoints.every(item => item.status === 'completed' && item.evidence.includes(receipts[0].evidenceRef)));
  assert(accepted.outputs.implement.value.verificationResults.every(item => item.evidenceRefs.includes(receipts[0].evidenceRef)));
  validateBusinessResult(accepted, { conversationVisible: true, feature });
});

test('Host failures, drift, missing and substituted receipts never create acceptance', () => {
  const {feature, result, receipts} = fixture();
  for (const bad of [[], [...receipts,receipts[0]], [{...receipts[0],check:{...receipts[0].check,covers:['unapproved']}}], [{...receipts[0], status:'failed'}], [{...receipts[0],sourceDrift:true}],
    [{...receipts[0],evidenceRef:null}], [{...receipts[0],approvedCheck:{...receipts[0].approvedCheck,command:['unapproved']}}]]) {
    assert.throws(() => completeVerifiedDelivery(result, feature, bad), {code:'DELIVERY_VERIFICATION_RECEIPTS_REQUIRED'});
  }
});

test('readiness cannot change the batch, checks, assigned evidence or widen the result scope', () => {
  for (const mutate of [r => r.verificationRequest.batchDigest='a'.repeat(64), r=>r.verificationRequest.checkIds.push('extra'),
    r=>r.checkpoints[0].status='completed', r=>r.checkpoints[0].evidence=[], r=>r.checkpoints.push({...r.checkpoints[0]}),
    r=>r.outputs={implement:{}}, r=>r.blocker={kind:'external',summary:'Unresolved dependency.'},
    r=>r.deliveryPrerequisites=[{id:'external'}]]) {
    const {feature,result}=fixture(); mutate(result);
    assert.throws(()=>assertVerificationReady(result,feature));
  }
  const {feature,result}=fixture(); delete feature.metadata.deliveryBatch;
  assert.throws(()=>assertVerificationReady(result,feature), {code:'DELIVERY_VERIFICATION_REQUEST_INVALID'});
  assert.throws(()=>assertVerificationReady(result,{metadata:{qualityReview:true}}), {code:'DELIVERY_VERIFICATION_REQUEST_INVALID'});
});

test('convergence readiness retains both upstream proof and original final checks', async()=>{
  const [producer,feature]=compile(); producer.state='completed';
  const result={...fixture().result,verificationRequest:{version:DELIVERY_VERIFICATION_HANDOFF,
    batchDigest:feature.metadata.deliveryPlanBinding.batchDigest,checkIds:feature.metadata.deliveryBatch.checks.map(c=>c.id)},
    checkpoints:feature.metadata.deliveryBatch.obligationIds.map(id=>({id,status:'implemented',summary:'Final acceptance candidate.',evidence:['src/receiver.mjs']}))};
  const observed=[];
  const actual=await verifyDeliveryBatchResult({state:{features:[producer,feature]},feature,
    dispatch:{execution:{implementationContinuation:{originalObligationIds:[...producer.metadata.deliveryBatch.obligationIds,...feature.metadata.deliveryBatch.obligationIds]}}},
    result,project:{workspace:{excluded:[]}},executeCheck:async({check,forceFresh})=>{
      observed.push({id:check.id,forceFresh});return {approvedCheck:check,check,status:'passed',sourceDrift:false,evidenceRef:`evidence:${check.id}`};
    }});
  assert.deepEqual(observed,[{id:'receiver',forceFresh:false},{id:'final',forceFresh:true}]);
  assert.equal(actual.result.status,'completed');assert.equal(actual.receipts.length,2);
  validateBusinessResult(actual.result,{conversationVisible:true,feature});
});

test('application runs original checks before acceptance and preserves native readiness on failure', async()=>{
  for(const status of ['passed','failed','environment-failed','budget-exceeded']) {
    const {feature,result}=fixture();let calls=0;
    const actual=await verifyDeliveryBatchResult({state:{},feature,dispatch:{execution:{implementationContinuation:{}}},result,
      project:{workspace:{excluded:[]}},executeCheck:async({check})=>{
        calls++; assert.equal(result.status,'verification-ready');
        assert.deepEqual(check,feature.metadata.deliveryBatch.checks[0]);
        return {check,approvedCheck:check,status,sourceDrift:false,evidenceRef:'evidence:host',executorReceipt:{payload:{stderr:'observed failure'}}};
      }});
    assert.equal(calls,1);assert.equal(actual.nativeResult,result);
    assert.equal(actual.result.status,status==='passed'?'completed':'blocked');
    assert.equal(actual.result.verificationRequest,undefined);
    validateBusinessResult(actual.result,{conversationVisible:true,feature});
    if(status!=='passed') {assert.deepEqual(actual.result.outputs,{});assert(actual.result.observations.includes('Host verification evidence: evidence:host'));}
  }
});
