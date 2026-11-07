import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {makeFixture,startRun,feature,dispatchAndBind,recordResult,command} from './test-support.mjs';
import {sha256,digestJson} from '../src/common/canonical.mjs';
import {validateContinuousExecution,executionProblemId} from '../src/common/continuous-execution.mjs';
import {featureContractDigest} from '../src/common/interruption-contract.mjs';
import {inspectDependencyRepair,completeDependencyRepairs} from '../src/kernel/dependency-repair.mjs';
import {carryInterventions} from '../src/kernel/intervention.mjs';
import {prepareImplementationEvidenceInputs} from '../src/application/implementation-evidence-inputs.mjs';
import {createCompletionCarryoverPlan} from '../src/kernel/completion-carryover.mjs';
import {captureWorkspace} from '../src/common/workspace-snapshot.mjs';
import {selectBlockedResumeFeature} from '../src/application/lifecycle-resume.mjs';
import {applyPendingInterruptionReviews,hasPendingIntervention,reviewableInterruptions} from '../src/application/interruption-review.mjs';

const setup=async (t,{sibling=false,mixed=false,explicit=false}={})=>{
 const f=await makeFixture({policy:{continuousExecution:validateContinuousExecution({version:'continuous-execution/1'}),
   projectFilePolicy:{version:'project-files/1',mode:'project-owned',roots:['src','tests'],protectedPaths:['.git']}}});t.after(f.cleanup);
 await mkdir(resolve(f.workspace,'src'));await writeFile(resolve(f.workspace,'src/owner.mjs'),'export const leak=true;');
 await startRun(f,{features:[feature('owner',{stage:'implementation'},{allowedPaths:explicit?['tests']:['src']}),
   ...(sibling?[feature('sibling',{stage:'implementation'},{dependsOn:['owner'],allowedPaths:['tests']})]:[]),
   feature('consumer',{stage:'implementation'},{dependsOn:['owner'],allowedPaths:['tests']})]});
 let d=await dispatchAndBind(f,'run');await recordResult(f,'run',d.dispatch);
 if(sibling){d=await dispatchAndBind(f,'run');await recordResult(f,'run',d.dispatch);}
 d=await dispatchAndBind(f,'run');await recordResult(f,'run',d.dispatch,{status:'blocked',summary:'Public consumer reproduces defect.',changedFiles:[],
   failureClass:mixed?'external-prerequisite':'scope-blocker',blocker:mixed?{kind:'external',summary:'Historical input absent; owner script also broken.'}:{kind:'scope',summary:'Production repair belongs to declared dependency.',repairCandidatePaths:['src/owner.mjs']}});
 await f.harness.scheduleInterruptionReview(f.projectId,'run','consumer','review');d=await dispatchAndBind(f,'run');
 const spec=d.dispatch.featureSnapshot.metadata.intervention;
 const owner=(await f.harness.authorityStore.read(f.projectId,'run')).features.find(f=>f.id==='owner');
 await recordResult(f,'run',d.dispatch,{status:'completed',summary:'Current source-bound diagnosis.',changedFiles:[],
   ...(mixed?{deliveryPrerequisites:[{id:'owner-route',summary:'Repair proof selector.',affectedPaths:['src/owner.mjs'],evidence:['src/owner.mjs'],classification:'delivery-prerequisite',reason:'Existing dependency defect.'},
     {id:'historical',summary:'Bind exact historical input.',affectedPaths:['tests/historical.json'],evidence:['src/owner.mjs'],classification:'delivery-prerequisite',reason:'Missing certified inputs.'}]}:{}),outputs:{diagnosis:{schemaId:'execution-diagnosis-v1',evidenceRefs:['src/owner.mjs'],value:{
   sourceSubmissionId:spec.sourceSubmissionId,contractDigest:spec.contractDigest,conclusion:'external-prerequisite',reason:'Existing dependency must repair the public defect; original contract retained.',
   evidence:[{path:'src/owner.mjs',sha256:sha256(await readFile(resolve(f.workspace,'src/owner.mjs')))}],repairPaths:mixed?[]:['src/owner.mjs'],
   ...(explicit?{resolutionActions:[{id:'owner-route',kind:'dependency-repair',summary:'Repair existing dependency.',paths:['src/owner.mjs'],ownerFeatureId:owner.id,ownerContractDigest:featureContractDigest(owner)},
     {id:'historical',kind:'input-discovery',summary:'Find historical input.',paths:[],discovery:{status:'pending',catalogs:[],inputs:[]}}]}:{}),
   remainingWork:[{work:'Dependency and receiver revalidation',existingImplementation:'Independent receiver reproduces defect.',remainingDevelopment:'Repair dependency then rerun original receiver.',verification:'Fresh complete original checks.',unknowns:[{question:'Dependency correction?',classification:'external-prerequisite',action:'Return to existing dependency.',verification:'Fresh dependency and receiver checks.',unitsIncluded:false}],units:3}]}}}});
 return {...f,reviewId:d.dispatch.featureId,state:await f.harness.authorityStore.read(f.projectId,'run')};
};

test('source-bound dependency return preserves contracts/history/budgets and requires new implementation before consumer continuation',async t=>{
 const f=await setup(t),before=f.state,contracts=before.features.map(featureContractDigest),attempts=digestJson(before.attempts);
 const selected=inspectDependencyRepair(before,f.reviewId);assert.equal(selected.ownerFeatureId,'owner');
 let s=(await f.harness.applyInterruptionReview(f.projectId,'run',f.reviewId,'return')).state;
 assert.equal(s.features[0].state,'pending');assert.equal(s.features[1].state,'blocked');
 assert.deepEqual(s.features.map(featureContractDigest),contracts);assert.equal(digestJson(s.attempts),attempts);
 assert.equal(s.metadata.dependencyRepairs.length,1);assert.equal(inspectDependencyRepair(s,f.reviewId),null);
 const replay=await f.harness.kernel.requestDependencyRepair(f.projectId,'run',{reviewFeatureId:f.reviewId,candidate:selected},
   {commandId:'return.dependency-return'});assert.equal(replay.reused,true);
 const refs=await prepareImplementationEvidenceInputs({state:s,feature:s.features[0],authorityStore:f.harness.authorityStore,evidenceStore:f.harness.evidenceStore});
 assert.equal(refs.length,1);const input=JSON.parse(await readFile(refs[0].path,'utf8'));
 assert.equal(input.kind,'dependency-repair-input');assert.equal(input.completionCredit,false);
 const d=await dispatchAndBind(f,'run');assert.equal(d.dispatch.featureId,'owner');
 await assert.rejects(recordResult(f,'run',d.dispatch),{code:'DEPENDENCY_REPAIR_COMPLETION_INVALID'});
 await writeFile(resolve(f.workspace,'src/owner.mjs'),'export const leak=false;');
 s=(await recordResult(f,'run',d.dispatch,{status:'completed',summary:'Fixed production defect.',changedFiles:['src/owner.mjs']})).state;
 assert.equal(s.features[1].state,'pending');assert.equal(s.metadata.dependencyRepairs[0].status,'completed');
 assert.equal(s.submissions.filter(x=>x.featureId==='owner').length,2);
 assert.equal(digestJson(s.attempts),attempts);assert.match(s.features[1].reopenReason,/fresh original verification/);
 assert.equal((await dispatchAndBind(f,'run')).dispatch.featureId,'consumer');
});

for(const explicit of [false,true])test(`mixed blockers repair the existing dependency before unavailable input; explicit identity=${explicit}`,async t=>{
 const f=await setup(t,{mixed:true,explicit});let reviewId=f.reviewId;
 if(!explicit){
  assert.equal(inspectDependencyRepair(f.state,reviewId),null,'Legacy mixed prose does not grant owner authority.');
  const clarified=(await f.harness.applyInterruptionReview(f.projectId,'run',reviewId,'clarify-mixed')).state;
  assert.equal(clarified.features.find(f=>f.id==='owner').state,'completed');
  const d=await dispatchAndBind(f,'run'),old=f.state.submissions.at(-1).result;
  const result=structuredClone(old),owner=clarified.features.find(f=>f.id==='owner');
  result.outputs.diagnosis.value.resolutionActions=[{id:'owner-route',kind:'dependency-repair',summary:'Repair existing owner.',paths:['src/owner.mjs'],ownerFeatureId:'owner',ownerContractDigest:featureContractDigest(owner)},
   {id:'historical',kind:'input-discovery',summary:'Find exact historical input.',paths:[],discovery:{status:'pending',catalogs:[],inputs:[]}}];
  await recordResult(f,'run',d.dispatch,result);reviewId=d.dispatch.featureId;
 }
 const before=await f.harness.authorityStore.read(f.projectId,'run');
 const candidate=inspectDependencyRepair(before,reviewId);assert.equal(candidate.ownerFeatureId,'owner');
 assert(candidate.unresolvedPrerequisites.some(p=>p.id==='historical'));
 const s=(await f.harness.applyInterruptionReview(f.projectId,'run',reviewId,'mixed-return')).state;
 assert.equal(s.features.find(f=>f.id==='owner').state,'pending');assert.equal(s.features.find(f=>f.id==='consumer').state,'blocked');
 assert.deepEqual(s.attempts,before.attempts);assert.deepEqual(s.features.map(featureContractDigest),before.features.map(featureContractDigest));
 const d=await dispatchAndBind(f,'run');assert.equal(d.dispatch.featureId,'owner');
 await writeFile(resolve(f.workspace,'src/owner.mjs'),'export const leak=false;');
 const completed=(await recordResult(f,'run',d.dispatch,{status:'completed',summary:'Repaired proof selector.',changedFiles:['src/owner.mjs']})).state;
 assert.equal(completed.metadata.dependencyRepairs[0].status,'completed');
 assert.equal(completed.features.find(f=>f.id==='consumer').state,'blocked','Missing historical evidence must not gain a retry or completion credit.');
 assert.equal(completed.features.find(f=>f.id==='owner').state,'completed');
 const carried={...structuredClone(completed),runId:'replacement',decisions:[],
  features:completed.features.filter(f=>f.kind!=='execution-diagnostic').map(f=>({...structuredClone(f),state:f.id==='consumer'?'pending':f.state})),
  metadata:{...structuredClone(completed.metadata),dependencyRepairs:[]}};
 await carryInterventions({state:carried,prior:completed,roots:new Set(completed.features.map(f=>f.logicalRoot)),evidenceStore:f.harness.evidenceStore});
 assert.equal(carried.features.find(f=>f.id==='consumer').state,'blocked','Formal replacement must preserve unresolved inputs after a completed repair.');
 assert.equal(carried.features.find(f=>f.id==='owner').state,'completed');
 assert.equal(reviewableInterruptions(carried)[0].feature.id,'consumer');
 const attemptsAfter=digestJson(completed.attempts),ledgerBefore=completed.metadata.interruptionLedger.length;
 assert.equal(hasPendingIntervention(completed),false,'Old-source completed diagnoses are audit history, not current work.');
 const settled=await applyPendingInterruptionReviews(f.harness,completed,'skip-stale-diagnoses');
 assert.equal(settled.revision,completed.revision);
 assert.equal(reviewableInterruptions(settled)[0].feature.id,'consumer');
 const fresh=await f.harness.scheduleInterruptionReview(f.projectId,'run','consumer','after-source-repair');
 assert.notEqual(fresh.result.featureId,reviewId,'Changed source must not collide with the old Submission diagnostic ID.');
 assert.equal(fresh.state.metadata.interruptionLedger.length,ledgerBefore+1);
 assert.equal(digestJson(fresh.state.attempts),attemptsAfter);
 const again=await f.harness.scheduleInterruptionReview(f.projectId,'run','consumer','same-source-observation');
 assert(!again||again.state.features.filter(x=>x.id===fresh.result.featureId).length===1);
 assert.equal((await f.harness.authorityStore.read(f.projectId,'run')).metadata.interruptionLedger.length,ledgerBefore+1);
});

test('dependency return invalidates exactly its completed consumers and preserves their full contracts and old evidence',async t=>{
 const f=await setup(t,{sibling:true}),old=f.state.features.find(x=>x.id==='sibling');
 const contract=featureContractDigest(old),oldSubmission=old.submissionId;
 const s=(await f.harness.applyInterruptionReview(f.projectId,'run',f.reviewId,'return-sibling')).state;
 assert.equal(s.features.find(x=>x.id==='sibling').state,'pending');
 assert.equal(featureContractDigest(s.features.find(x=>x.id==='sibling')),contract);
 assert(s.submissions.some(x=>x.submissionId===oldSubmission&&x.result.status==='completed'));
 assert.deepEqual(s.metadata.dependencyRepairs[0].revalidation,[{featureId:'sibling',contractDigest:contract,submissionId:oldSubmission}]);
 assert.equal(s.features.find(x=>x.id==='consumer').state,'blocked');
});

test('mixed legacy diagnosis survives formal replacement as blocked work needing one structured clarification',async t=>{
 const f=await setup(t,{mixed:true});const prior=(await f.harness.applyInterruptionReview(f.projectId,'run',f.reviewId,'mixed-assess')).state;
 // Simulate a crash before the newly reserved clarification runs. Both original
 // and pending clarification remain bound to the same source and ledger.
 const next={...structuredClone(prior),runId:'replacement',features:prior.features.filter(f=>f.kind!=='execution-diagnostic').map(f=>({...f,state:f.id==='consumer'?'pending':f.state})),
  decisions:[],metadata:{...structuredClone(prior.metadata)}};
 await carryInterventions({state:next,prior,roots:new Set(prior.features.map(f=>f.logicalRoot)),evidenceStore:f.harness.evidenceStore});
 assert.equal(next.features.find(f=>f.id==='consumer').state,'blocked');
 assert.equal(next.features.filter(f=>f.kind==='execution-diagnostic'&&f.state==='pending').length,1);
 assert.deepEqual(next.metadata.interruptionLedger,prior.metadata.interruptionLedger);assert.deepEqual(next.attempts,prior.attempts);
});

test('dependency selection uses the Authority accepted completion rather than the last historical array item',async t=>{
 const f=await setup(t),s=structuredClone(f.state),owner=s.features.find(f=>f.id==='owner');
 const accepted=s.submissions.find(x=>x.submissionId===owner.submissionId);
 s.submissions.push({...structuredClone(accepted),submissionId:'later-historical-copy'});
 assert.equal(inspectDependencyRepair(s,f.reviewId).ownerSubmissionId,owner.submissionId);
 const invalid=structuredClone(s);invalid.submissions.find(x=>x.submissionId===owner.submissionId).featureId='foreign';
 assert.equal(inspectDependencyRepair(invalid,f.reviewId),null);
});

test('explicit dependency identities cannot target a consumer, another contract or protected project paths',async t=>{
 const f=await setup(t,{mixed:true,explicit:true});
 for(const mutate of [a=>a.ownerFeatureId='consumer',a=>a.ownerContractDigest='0'.repeat(64),a=>a.paths=['../outside'],a=>a.paths=['.git/config']]){
  const s=structuredClone(f.state);mutate(s.submissions.at(-1).result.outputs.diagnosis.value.resolutionActions[0]);
  assert.equal(inspectDependencyRepair(s,f.reviewId),null);
 }
});

test('Kernel replacement restores the reviewed blocker and directly schedules its existing dependency without another diagnosis',async t=>{
 const f=await setup(t),store=f.harness.authorityStore;
 const prior=(await store.transact(f.projectId,'run',{...command(f.state),payload:{}},s=>{s.metadata.commandIntent={action:'implement'};})).state;
 const replacementFeatures=prior.features.filter(f=>f.kind!=='execution-diagnostic').map(f=>{
   const x=structuredClone(f);x.state='pending';delete x.submissionId;delete x.blocker;return x;
 });
 const plan=createCompletionCarryoverPlan({prior,replacementFeatures,replacementRunId:'replacement',replacementPlanDigest:'b'.repeat(64),patchReceiptDigest:'c'.repeat(64),sourceDigest:prior.sourceDigest});
 await f.harness.kernel.supersedeRun(f.projectId,'run',{replacementRunId:'replacement',planDigest:plan.replacementPlanDigest,reason:'test-h4',
   completionCarryover:{plan,replacementPlan:{planDigest:plan.replacementPlanDigest,run:{runId:'replacement'}}}},command(prior));
 let s=(await f.harness.kernel.startRun({projectId:f.projectId,runId:'replacement',profileId:prior.profile.id,features:replacementFeatures,
   sourceDigest:prior.sourceDigest,pluginSetDigest:prior.pluginSetDigest,metadata:{...prior.metadata,lifecyclePlanDigest:plan.replacementPlanDigest},
   completionCarryover:{priorRunId:'run',carryoverDigest:plan.carryoverDigest}},command())).state;
 assert.equal(s.features.find(x=>x.id==='consumer').state,'blocked');assert(inspectDependencyRepair(s,f.reviewId));
 s=(await f.harness.applyInterruptionReview(f.projectId,'replacement',f.reviewId,'replacement-return')).state;
 assert.equal(s.features.find(x=>x.id==='owner').state,'pending');assert.equal(s.metadata.interruptionLedger.length,1);
 assert.deepEqual(s.attempts,prior.attempts);assert.equal(s.metadata.dependencyRepairs.length,1);
});

test('dependency return refuses ambiguity, foreign paths, stale source, active work, stopped/budgeted execution and completed consumers',async t=>{
 const f=await setup(t);
 for(const mutate of [
   s=>s.features.push({...structuredClone(s.features[0]),id:'second-owner'})&&s.features[1].dependsOn.push('second-owner'),
   s=>s.features[0].allowedPaths=['elsewhere'],
   s=>s.sourceDigest='f'.repeat(64),
   s=>s.leases.push({status:'active'}),
   s=>s.metadata.operatorStop={requested:true},
   s=>s.features.push({...structuredClone(s.features[1]),id:'accepted-consumer',state:'completed'}),
   s=>s.submissions.at(-1).result.outputs.diagnosis.value.conclusion='contract-change',
   s=>s.submissions.at(-1).result.outputs.diagnosis.value.repairPaths=['../escape'],
 ]){const s=structuredClone(f.state);mutate(s);assert.equal(inspectDependencyRepair(s,f.reviewId),null);}
 const candidate=inspectDependencyRepair(f.state,f.reviewId);
 await assert.rejects(f.harness.kernel.requestDependencyRepair(f.projectId,'run',{reviewFeatureId:f.reviewId,candidate},command(f.state)),{code:'DEPENDENCY_REPAIR_ASSESSMENT_REQUIRED'});
});

test('formal carry-over retains a blocked diagnostic frontier and pending dependency return without resetting history',async t=>{
 const f=await setup(t);let prior=f.state;
 const makeNext=()=>({...structuredClone(prior),runId:'replacement',features:prior.features.filter(x=>x.kind!=='execution-diagnostic').map(x=>({...structuredClone(x),state:x.id==='consumer'?'pending':x.state})),decisions:[],metadata:{...structuredClone(prior.metadata),dependencyRepairs:undefined}});
 let next=makeNext();await carryInterventions({state:next,prior,roots:new Set(prior.features.map(x=>x.logicalRoot)),evidenceStore:f.harness.evidenceStore});
 assert.equal(next.features.find(x=>x.id==='consumer').state,'blocked');assert(inspectDependencyRepair(next,f.reviewId));
 prior=(await f.harness.applyInterruptionReview(f.projectId,'run',f.reviewId,'return-before-recovery')).state;
 next=makeNext();await carryInterventions({state:next,prior,roots:new Set(prior.features.map(x=>x.logicalRoot)),evidenceStore:f.harness.evidenceStore});
 assert.deepEqual(next.metadata.dependencyRepairs,prior.metadata.dependencyRepairs);
 assert.equal(next.features.find(x=>x.id==='owner').state,'pending');assert.equal(next.features.find(x=>x.id==='consumer').state,'blocked');
 assert.deepEqual(next.attempts,prior.attempts);
});

const prepareCorrectedHandoff=async(t,{revert=false}={})=>{
 const f=await setup(t);
 await f.harness.applyInterruptionReview(f.projectId,'run',f.reviewId,'return-corrected');
 let d=await dispatchAndBind(f,'run');
 await writeFile(resolve(f.workspace,'src/owner.mjs'),'export const leak=false;');
 let s=(await recordResult(f,'run',d.dispatch,{status:'failed',summary:'Implementation retained; result handoff rejected.',changedFiles:['src/owner.mjs'],
   failureClass:'runtime-contract',blocker:{kind:'runtime-contract',code:'DELIVERY_VERIFICATION_REQUEST_INVALID',summary:'Correct the handoff.'}})).state;
 const implementation=s.submissions.at(-1),accounting=digestJson(s.attempts);
 await f.harness.kernel.reopenFeature(f.projectId,'run',{featureId:'owner',reason:'Correct result contract without unnecessary code changes.'},command(s));
 if(revert){
   d=await dispatchAndBind(f,'run');await writeFile(resolve(f.workspace,'src/owner.mjs'),'export const leak=true;');
   await writeFile(resolve(f.workspace,'src/unrelated.mjs'),'export const unrelated=true;');
   s=(await recordResult(f,'run',d.dispatch,{status:'failed',summary:'Repair reverted with unrelated change.',changedFiles:['src/owner.mjs','src/unrelated.mjs'],
     failureClass:'runtime-contract',blocker:{kind:'runtime-contract',summary:'Still incomplete.'}})).state;
   await f.harness.kernel.reopenFeature(f.projectId,'run',{featureId:'owner',reason:'Inspect final evidence.'},command(s));
 }
 d=await dispatchAndBind(f,'run');
 return {...f,dispatch:d.dispatch,implementation,accounting};
};

test('corrected no-edit handoff completes the retained implementation chain and preserves failure accounting',async t=>{
 const f=await prepareCorrectedHandoff(t);
 const s=(await recordResult(f,'run',f.dispatch)).state,repair=s.metadata.dependencyRepairs[0];
 assert.equal(repair.status,'completed');assert.deepEqual(repair.implementationSubmissionIds,[f.implementation.submissionId]);
 assert.equal(repair.repairSubmissionId,s.submissions.at(-1).submissionId);
 assert.equal(s.submissions.at(-1).inputSourceDigest,s.submissions.at(-1).outputSourceDigest);
 assert.deepEqual(s.submissions.at(-1).changedFiles,[]);assert.equal(s.features[1].state,'pending');
 assert.equal(digestJson(s.attempts),f.accounting);assert.equal(s.submissions.find(x=>x.submissionId===f.implementation.submissionId).result.status,'failed');
});

test('formal replacement retains the implementation chain for a fresh corrected handoff',async t=>{
 const f=await prepareCorrectedHandoff(t),store=f.harness.authorityStore;
 let prior=await store.read(f.projectId,'run');
 prior=(await f.harness.kernel.recover(f.projectId,'run',{mode:'ordinary-resume'},command(prior))).state;
 prior=(await store.transact(f.projectId,'run',{...command(prior),payload:{}},s=>{s.metadata.commandIntent={action:'implement',target:'fixture-version'};})).state;
 const features=prior.features.filter(x=>x.kind!=='execution-diagnostic').map(x=>{
   const result=structuredClone(x);result.state='pending';delete result.submissionId;delete result.blocker;return result;
 });
 const plan=createCompletionCarryoverPlan({prior,replacementFeatures:features,replacementRunId:'replacement',
   replacementPlanDigest:'b'.repeat(64),patchReceiptDigest:'c'.repeat(64),sourceDigest:prior.sourceDigest,includeIncomplete:true});
 await f.harness.kernel.supersedeRun(f.projectId,'run',{replacementRunId:'replacement',planDigest:plan.replacementPlanDigest,reason:'test-h4',
   completionCarryover:{plan,replacementPlan:{planDigest:plan.replacementPlanDigest,run:{runId:'replacement'}}}},command(prior));
 const next=(await f.harness.kernel.startRun({projectId:f.projectId,runId:'replacement',profileId:prior.profile.id,features,
   sourceDigest:prior.sourceDigest,pluginSetDigest:prior.pluginSetDigest,metadata:{...prior.metadata,lifecyclePlanDigest:plan.replacementPlanDigest},
   completionCarryover:{priorRunId:'run',carryoverDigest:plan.carryoverDigest}},command())).state;
 assert.deepEqual(next.attempts,prior.attempts);assert.deepEqual(next.metadata.dependencyRepairs,prior.metadata.dependencyRepairs);
 assert.equal(selectBlockedResumeFeature(next),null,'Pending dependency repair must run before its blocked consumer.');
 const evidence=await f.harness.evidenceStore.put(await captureWorkspace(f.workspace),{projectId:f.projectId,runId:'replacement',
   epoch:next.epoch,generation:next.generation,sourceDigest:next.sourceDigest});
 const scheduled=await f.harness.kernel.schedule(f.projectId,'replacement',{runtimePluginId:'test-runtime',
   runtimeRequirements:f.dispatch.execution.runtime,sourceSnapshotRef:evidence.ref,executionByFeatureId:{owner:f.dispatch.execution}},command(next));
 const dispatch=scheduled.result.dispatches[0];assert.equal(dispatch.featureId,'owner');
 await f.harness.bindDispatch(f.projectId,'replacement',{dispatchId:dispatch.dispatchId,packetDigest:dispatch.packetDigest,
   agentId:`agent-${dispatch.dispatchId}`,runtimeReceipt:{runtimePluginId:'test-runtime'}},command(scheduled.state));
 const s=(await recordResult(f,'replacement',dispatch)).state;
 assert.equal(s.metadata.dependencyRepairs[0].status,'completed');
 assert.deepEqual(s.metadata.dependencyRepairs[0].implementationSubmissionIds,[f.implementation.submissionId]);
 assert.equal(s.features.find(x=>x.id==='consumer').state,'pending');assert.deepEqual(s.attempts,prior.attempts);
});

test('handoff correction cannot credit reverted repair paths, foreign source history or missing implementation evidence',async t=>{
 const f=await prepareCorrectedHandoff(t,{revert:true});
 await assert.rejects(recordResult(f,'run',f.dispatch),{code:'DEPENDENCY_REPAIR_COMPLETION_INVALID'});
 const g=await prepareCorrectedHandoff(t),state=await g.harness.authorityStore.read(g.projectId,'run');
 const candidate={submissionId:'candidate',featureId:'owner',dispatchId:g.dispatch.dispatchId,inputSourceDigest:state.sourceDigest,
   outputSourceDigest:state.sourceDigest,changedFiles:[],result:{status:'completed'}};
 for(const mutate of [s=>s.submissions.at(-1).featureId='consumer',s=>s.submissions.at(-1).evidenceRefs=[],
   s=>s.submissions.at(-1).inputSourceDigest='0'.repeat(64),s=>s.submissions.at(-1).submittedAt='2000-01-01T00:00:00.000Z']){
   const s=structuredClone(state);mutate(s);
   await assert.rejects(completeDependencyRepairs(s,candidate,()=>new Date().toISOString(),g.harness.evidenceStore),{code:'DEPENDENCY_REPAIR_COMPLETION_INVALID'});
 }
});
