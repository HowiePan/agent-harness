import assert from 'node:assert/strict';
import test from 'node:test';
import {inspectDeliveryFailureRetries} from '../src/application/delivery-failure-retry.mjs';
import {selectBlockedResumeFeature} from '../src/application/lifecycle-resume.mjs';
test('observed Host timeout can reopen its owner under the original remaining attempt budget',async()=>{
 const ref='evidence:'+ 'a'.repeat(64)+':'+ 'b'.repeat(64);
 const check={id:'original',command:['node','check.mjs']};
 const feature={id:'owner',state:'blocked',logicalRoot:'owner',dependsOn:[],metadata:{stage:'implementation',deliveryBatch:{checks:[check]}}};
 const submission={featureId:'owner',submissionId:'sub',dispatchId:'dispatch',submissionDigest:'sub-digest',outputSourceDigest:'source',evidenceRefs:[ref],
 result:{status:'blocked',failureClass:'environment',blocker:{kind:'environment',resumeWhen:'proof: '+ref}}};
 const state={projectId:'p',sourceDigest:'source',features:[feature],submissions:[submission],metadata:{projectFilePolicy:{mode:'project-owned'}},
 attempts:{'owner:environment':{key:'owner:environment',logicalRoot:'owner',failureClass:'environment',failures:1,limit:3,exhausted:false}}};
 const body={kind:'delivery-verification-receipt',status:'environment-failed',cacheHit:false,sourceDrift:false,sourceBefore:'source',sourceAfter:'source',approvedCheck:check,
 executorReceipt:{payload:{environmentError:{code:'GATE_PROCESS_TIMEOUT'},resourceReceipt:{supervised:true}}}};
 const record={metadata:{projectId:'p',featureId:'owner',dispatchId:'dispatch',sourceDigest:'source'},bytes:Buffer.from(JSON.stringify(body))};
 const store={read:async()=>record};
 const reviews=await inspectDeliveryFailureRetries(state,store);
 assert.equal(reviews.length,1);assert.equal(selectBlockedResumeFeature(state,{hostCheckReviews:reviews}),'owner');
 state.attempts['owner:environment'].exhausted=true;assert.deepEqual(await inspectDeliveryFailureRetries(state,store),[]);
 state.attempts['owner:environment'].exhausted=false;
 for(const changed of [{...body,sourceDrift:true},{...body,approvedCheck:{id:'substituted'}},{...body,executorReceipt:{payload:{environmentError:{code:'RESOURCE_SUPERVISOR_UNAVAILABLE'}}}}]){
 record.bytes=Buffer.from(JSON.stringify(changed));assert.deepEqual(await inspectDeliveryFailureRetries(state,store),[]);
 }
});
