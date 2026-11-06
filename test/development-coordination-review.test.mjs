import test from 'node:test';
import assert from 'node:assert/strict';
import { digestJson } from '../src/common/canonical.mjs';
import { featureContractDigest } from '../src/common/interruption-contract.mjs';
import { compile } from './delivery-batch-support.mjs';
import { evidenceFixture } from './implementation-evidence-support.mjs';
import { rebindDevelopmentCoordinationReview,prepareDevelopmentCoordinationReview,inspectRestoredCoordination, reviewDevelopmentCoordination, inspectDevelopmentCoordinationReview } from '../src/application/development-coordination-review.mjs';
import { classifyLocalIncident } from '../src/application/local-incident.mjs';
import { selectBlockedResumeFeature } from '../src/application/lifecycle-resume.mjs';

const fixture = () => {
  const f=evidenceFixture();
  const feature=compile()[0]; feature.state='blocked'; feature.logicalRoot='owner';
  feature.metadata.deliveryBatch.checks[0].inputs=['src/application/development-coordination-review.mjs'];
  const blocker={kind:'prerequisite',code:'host-check-order-and-retirement-evidence-input',summary:'Old coordination blocker.'};
  feature.blocker=blocker;
  const result={status:'blocked',failureClass:'external-prerequisite',blocker,deliveryPrerequisites:
    ['approved-host-pre-submission-check-capability','pinned-retirement-evidence-input'].map(id=>({id}))};
  const body={featureId:feature.id,dispatchId:'latest',evidenceRefs:['submission'],outputSourceDigest:'source',result};
  const submission={...body,submissionDigest:digestJson(body)};
  Object.assign(f.state,{status:'ready',revision:7,sourceDigest:'source',authorityDigest:'before',features:[feature],
    submissions:[submission],leases:[],dispatches:[],decisions:[],attempts:{'owner:external-prerequisite':{failures:2,limit:3,exhausted:false,logicalRoot:'owner'}}});
  Object.assign(f.state.metadata,{commandIntent:{action:'implement'},workspace:{root:process.cwd()}});
  f.feature=feature; f.submission=submission;
  f.project={workspace:{excluded:[]}};
  f.carryover={firstPendingFeatureId:feature.id,priorAuthorityDigest:'before',carryoverDigest:'carry',replacementRunId:'new'};
  f.review={kind:'delivery-coordination-review',actor:'operator',projectId:'project',runId:'current',featureId:feature.id,
    expectedRevision:7,sourceDigest:'source',submissionDigest:submission.submissionDigest,contractDigest:featureContractDigest(feature),blockerDigest:digestJson(blocker)};
  return f;
};

test('observed restoration seals only the exact legacy coordinator prerequisites without acceptance or counter reset',async()=>{
  const f=fixture(); const before=digestJson(f.state); let proof;
  f.evidenceStore.put=async(body,metadata)=>{proof={body,metadata};return {ref:'restored'};};
  const actual=await inspectRestoredCoordination(f);
  assert.equal(actual.draftInputs.length,1);assert.equal(actual.acceptanceGranted,false);
  const resolution=await reviewDevelopmentCoordination(f);
  assert.equal(resolution.kind,'delivery-coordination-resolution');assert.equal(digestJson(f.state),before);
  const prior={...f.state,status:'superseded',authorityDigest:'after',metadata:{...f.state.metadata,
    supersededByRunId:'new',completionCarryover:{plan:f.carryover,environmentReview:resolution}}};
  const state={...f.state,runId:'new',metadata:{...f.state.metadata,completionCarryover:{progressOnly:true,
    priorRunId:'current',priorAuthorityDigest:'after',carryoverDigest:'carry'}}};
  const options={read:async()=>({bytes:Buffer.from(JSON.stringify(proof.body)),metadata:proof.metadata})};
  const reviews=await inspectDevelopmentCoordinationReview(state,{read:async()=>prior},options);
  assert.equal(selectBlockedResumeFeature(state,{hostCheckReviews:reviews}),f.feature.id);
  await assert.rejects(inspectDevelopmentCoordinationReview({...state,sourceDigest:'changed'},{read:async()=>prior},options));
  proof.body.acceptanceGranted=true;
  await assert.rejects(inspectDevelopmentCoordinationReview(state,{read:async()=>prior},options));
});

test('ancestry preflight retains only its observed proof before graph expansion and cannot waive later stops or drift',async()=>{
  for(const mutate of [null,f=>f.state.metadata.operatorStop={requested:true},f=>f.state.sourceDigest='changed',f=>f.state.revision++]) {
    const f=fixture();await prepareDevelopmentCoordinationReview(f);
    f.authorityStore.read=async()=>assert.fail('must not reload large ancestry after graph expansion');
    f.evidenceStore.put=async()=>({ref:'proof'});
    if(mutate){mutate(f);await assert.rejects(reviewDevelopmentCoordination(f));}
    else assert.equal((await reviewDevelopmentCoordination(f)).kind,'delivery-coordination-resolution');
  }
});

test('H3 pending claim refresh preserves the exact restoration proof and rejects changed inputs',async()=>{
  const f=fixture();let proof;
  f.evidenceStore.put=async(body,metadata)=>{proof={bytes:Buffer.from(JSON.stringify(body)),metadata};return {ref:'restored'};};
  const resolution=await reviewDevelopmentCoordination(f),read=f.evidenceStore.read;
  f.evidenceStore.read=async ref=>ref==='restored'?proof:read(ref);
  const prior={...f.state,status:'superseded',authorityDigest:'after',metadata:{...f.state.metadata,
    completionCarryover:{plan:f.carryover,environmentReview:resolution}}};
  const carryover={...f.carryover,carryoverDigest:'new-carry',replacementRunId:'next'};
  const rebound=await rebindDevelopmentCoordinationReview({prior,carryover,evidenceStore:f.evidenceStore});
  assert.equal(rebound.evidenceRef,resolution.evidenceRef);assert.equal(rebound.carryoverDigest,'new-carry');
  assert.equal(rebound.priorAuthorityDigest,'after');assert.equal(rebound.reboundFrom.carryoverDigest,'carry');
  await assert.rejects(rebindDevelopmentCoordinationReview({prior:{...prior,sourceDigest:'changed'},carryover,evidenceStore:f.evidenceStore}));
  f.evidence.bytes=Buffer.from('altered draft');
  await assert.rejects(rebindDevelopmentCoordinationReview({prior,carryover,evidenceStore:f.evidenceStore}));
});

test('real external prerequisites, missing inputs, active work and operator stops remain blocked',async()=>{
  for(const change of [
    f=>f.submission.result.blocker.code='human-approval-required',
    f=>f.submission.result.deliveryPrerequisites[0].id='external-service',
    f=>f.state.leases.push({status:'active'}),f=>f.state.metadata.operatorStop={requested:true},
    f=>f.state.decisions.push({action:'freeze-execution',decision:'approved'}),
    f=>f.submission.outputSourceDigest='changed',f=>delete f.nodes.retired,
    f=>f.feature.metadata.deliveryBatch.checks[0].inputs=['missing-required-input.mjs'],
  ]) {
    const f=fixture();change(f);await assert.rejects(inspectRestoredCoordination(f));
  }
});

test('capability inspection may substantiate a budget proposal but never waives an exhausted budget',async()=>{
  const f=fixture();Object.assign(f.state.attempts['owner:external-prerequisite'],{failures:3,exhausted:true});
  assert.equal((await inspectRestoredCoordination(f)).budgetUnchanged,true);
  f.evidenceStore.put=async()=>{assert.fail('must not seal recovery while exhausted');};
  await assert.rejects(reviewDevelopmentCoordination(f),{code:'DEVELOPMENT_COORDINATION_REVIEW_INVALID'});
});

test('pre-dispatch coordination evidence failures are Harness incidents; unknown failures retain diagnosis',()=>{
  for(const code of ['IMPLEMENTATION_EVIDENCE_LINEAGE_LIMIT','IMPLEMENTATION_DRAFT_EVIDENCE_INVALID','DEVELOPMENT_COORDINATION_REVIEW_INVALID']) {
    const incident=classifyLocalIncident({error:{code},phase:'preflight'});
    assert.equal(incident.origin,'harness');assert.equal(incident.patchLevelHint,'H3');
  }
  assert.equal(classifyLocalIncident({error:{code:'UNKNOWN'}}).origin,'undetermined');
  assert.equal(classifyLocalIncident({error:{code:'AUTHORITY_DIGEST_MISMATCH'}}).patchLevelHint,'H4');
});
