import test from 'node:test';
import assert from 'node:assert/strict';
import {makeFixture,startRun,feature,dispatchAndBind,recordResult,command} from './test-support.mjs';
import {createCompletionCarryoverPlan} from '../src/kernel/completion-carryover.mjs';
import {createLifecycleContinuation,withLifecycleContinuation} from '../src/application/lifecycle-continuation.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {digestJson} from '../src/common/canonical.mjs';
import {createLifecycleCommandBoundary,createLifecycleCommandHost} from '../src/application/lifecycle-command-context.mjs';

const setup=async t=>{
 const f=await makeFixture();t.after(f.cleanup);
 await startRun(f,{features:[feature('done',{stage:'implementation'}),feature('next',{stage:'implementation'},{dependsOn:['done']})]});
 const d=await dispatchAndBind(f,'run');await recordResult(f,'run',d.dispatch);
 let prior=await f.harness.authorityStore.read(f.projectId,'run');
 prior=(await f.harness.authorityStore.transact(f.projectId,'run',{...command(prior),payload:{}},s=>{
   s.metadata.commandIntent={action:'implement',target:'V-next'};s.metadata.lifecycleInvocationId='original-command';s.metadata.lifecycleUserCommandId='original-command';s.metadata.logicalTaskKey='original-goal';
 })).state;
 const project=await f.harness.projectRegistry.get(f.projectId);
 const plan={planDigest:'b'.repeat(64),project:{id:project.id,descriptorDigest:project.descriptorDigest},intent:{action:'implement',target:'V-next'},
   logicalTaskKey:'original-goal',harness:{artifactDigest:null},run:{runId:'replacement',sourceDigest:prior.sourceDigest,executionWorkspaceRoot:f.workspace}};
 const replacementFeatures=prior.features.map(x=>({...x,state:'pending'}));
 const patchBody={kind:'development-patch-receipt',level:'H4',migrationRunId:'run',authorityDecision:{decision:'approved'},
   affectedRuns:[{projectId:f.projectId,runId:'run',revision:prior.revision}]};
 const patch={...patchBody,receiptDigest:digestJson(patchBody)};
 await mkdir(resolve(f.dataRoot,'development','patches'),{recursive:true});
 await writeFile(resolve(f.dataRoot,'development','patches','fixture.json'),JSON.stringify(patch));
 const carry=createCompletionCarryoverPlan({prior,replacementFeatures,replacementRunId:plan.run.runId,replacementPlanDigest:plan.planDigest,
   patchReceiptDigest:patch.receiptDigest,sourceDigest:prior.sourceDigest});
 await f.harness.kernel.supersedeRun(f.projectId,'run',{replacementRunId:plan.run.runId,planDigest:plan.planDigest,
   reason:`development-h4-recovery:${carry.patchReceiptDigest}`,completionCarryover:{plan:carry,replacementPlan:plan}},command(prior));
 const host=createLifecycleCommandHost({provider:'fixture-current-command',verifyCommand:async()=>({verified:true,purpose:'business',
   reference:'fixture-user-event',commandId:'original-command',scope:{projectId:f.projectId,action:'implement',target:'V-next',workspaceRoot:f.workspace}}),verifyActive:async()=>({active:true})});
 const commandBoundary=createLifecycleCommandBoundary({root:f.dataRoot,host});
 return {...f,project,plan,priorRunId:'run',authorityStore:f.harness.authorityStore,evidenceStore:f.harness.evidenceStore,commandBoundary};
};

test('sealed continuation survives an interrupted reservation and retains one exact command authority',async t=>{
 const f=await setup(t);
 await f.commandBoundary.run({commandId:'original-command'},async()=>{
 await f.commandBoundary.assertPlan({...f.plan,planDigest:'prior-plan',run:{...f.plan.run,runId:'run'}});
 const first=await createLifecycleContinuation(f);
 await assert.rejects(withLifecycleContinuation(f,async receipt=>{assert.equal(receipt.receiptDigest,first.receiptDigest);throw Error('controlled process interruption');}),/controlled process interruption/);
 const output=await withLifecycleContinuation(f,async receipt=>{
   assert.equal(receipt.receiptDigest,first.receiptDigest);assert.equal(receipt.evidenceRef,first.evidenceRef);
   return {status:'completed',originalGoal:receipt.logicalTaskKey};
 });
 assert.equal(output.originalGoal,'original-goal');assert.equal((await createLifecycleContinuation(f)).commandId,first.commandId);
 assert.equal(await f.authorityStore.read(f.projectId,'replacement',{required:false}),null);
 await assert.rejects(withLifecycleContinuation(f,async()=>({status:'completed'})),{code:'COMMAND_ACTION_NO_PROGRESS'});
 });
 await assert.rejects(f.commandBoundary.run({commandId:'original-command'},async()=>{}),{code:'USER_COMMAND_ALREADY_CONSUMED'});
});

test('continuation refuses changed targets, project boundaries, plans and stopped original authorization',async t=>{
 const f=await setup(t);
 await assert.rejects(createLifecycleContinuation({...f,commandBoundary:null}),{code:'CURRENT_USER_COMMAND_REQUIRED'});
 await assert.rejects(createLifecycleContinuation({...f,commandBoundary:{assertPlan:async()=>{}}}),{code:'CURRENT_USER_COMMAND_REQUIRED'});
 await f.commandBoundary.run({commandId:'original-command'},async()=>{
 for(const mutate of [p=>p.intent.target='different',p=>p.project.id='other-project',p=>p.run.executionWorkspaceRoot+='-other',p=>p.planDigest='d'.repeat(64)]){
   const plan=structuredClone(f.plan);mutate(plan);await assert.rejects(createLifecycleContinuation({...f,plan}),error=>['CURRENT_USER_COMMAND_SCOPE_MISMATCH','LIFECYCLE_CONTINUATION_SCOPE_INVALID'].includes(error.code));
 }
 const prior=await f.authorityStore.read(f.projectId,'run');
 await f.authorityStore.transact(f.projectId,'run',{...command(prior),payload:{}},s=>{s.metadata.operatorStop={requested:true};});
 await assert.rejects(createLifecycleContinuation(f),{code:'LIFECYCLE_CONTINUATION_SCOPE_INVALID'});
 });
});
