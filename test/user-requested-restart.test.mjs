import test from 'node:test';
import assert from 'node:assert/strict';
import {makeFixture,startRun,command} from './test-support.mjs';
import {createLifecycleCommandHost,createLifecycleCommandBoundary} from '../src/application/lifecycle-command-context.mjs';
import {resumeForCurrentUserCommand} from '../src/application/user-requested-restart.mjs';
import {digestJson} from '../src/common/canonical.mjs';

const setup=async t=>{
 const f=await makeFixture();t.after(f.cleanup);let state=await startRun(f);
 state=(await f.harness.authorityStore.transact(f.projectId,'run',{...command(state),payload:{}},s=>{
   s.metadata.commandIntent={action:'implement',target:'V-next'};s.metadata.lifecyclePlanDigest='sealed-plan';
 })).state;
 state=(await f.harness.kernel.recordDecision(f.projectId,'run',{id:'old-user-stop',actor:'human-user',decision:'approved',action:'stop-execution',
   context:{projectId:f.projectId,runId:'run',sourceDigest:state.sourceDigest,priorAuthorityDigest:state.authorityDigest}},command(state))).state;
 const scope={projectId:f.projectId,action:'implement',target:'V-next',workspaceRoot:f.workspace};
 const plan={project:{id:f.projectId},intent:{action:'implement',target:'V-next'},run:{runId:'run',executionWorkspaceRoot:f.workspace},planDigest:'sealed-plan'};
 const boundary=({issuedAt,purpose='business',reference='new-user-event'}={})=>createLifecycleCommandBoundary({root:f.dataRoot,
   host:createLifecycleCommandHost({provider:'restart-fixture',verifyCommand:async request=>({verified:true,purpose,reference,
     commandId:request.commandId,userIssuedAt:issuedAt,scope}),verifyActive:async()=>({active:true})})});
 return {...f,state,scope,plan,boundary};
};

test('maintenance, old command timestamps and absent command context cannot resume a stopped Run',async t=>{
 const f=await setup(t),before=f.state.authorityDigest;
 for(const input of [{}, {issuedAt:f.state.metadata.operatorStop.at}, {issuedAt:'2000-01-01T00:00:00Z'}]){
   const commandBoundary=f.boundary({...input,reference:JSON.stringify(input)});
   await assert.rejects(commandBoundary.run({commandId:'stale-user'},()=>resumeForCurrentUserCommand({state:f.state,plan:f.plan,commandBoundary,kernel:f.harness.kernel})),
     {code:'USER_RESTART_REQUIRES_NEW_COMMAND'});
 }
 const maintenance=f.boundary({purpose:'maintenance'});
 await assert.rejects(maintenance.run({commandId:'maintenance'},()=>{}),{code:'CURRENT_USER_COMMAND_REQUIRED'});
 const noContext=f.boundary();await assert.rejects(resumeForCurrentUserCommand({state:f.state,plan:f.plan,commandBoundary:noContext,kernel:f.harness.kernel}),{code:'CURRENT_USER_COMMAND_REQUIRED'});
 await assert.rejects(resumeForCurrentUserCommand({state:f.state,plan:f.plan,commandBoundary:{userRestartProof:async()=>({commandId:'forged'})},kernel:f.harness.kernel}),{code:'CURRENT_USER_COMMAND_REQUIRED'});
 assert.equal((await f.harness.authorityStore.read(f.projectId,'run')).authorityDigest,before);
});

test('fresh user restart records exact authority and preserves source, contracts, attempts and existing evidence',async t=>{
 const f=await setup(t),commandBoundary=f.boundary({issuedAt:new Date().toISOString()});
 const preserved=s=>digestJson({source:s.sourceDigest,features:s.features,attempts:s.attempts,submissions:s.submissions,gates:s.gates,evidenceRefs:s.evidenceRefs});
 const after=await commandBoundary.run({commandId:'fresh-user'},async()=>{
   const next=await resumeForCurrentUserCommand({state:f.state,plan:f.plan,commandBoundary,kernel:f.harness.kernel});
   await commandBoundary.assertState(next);return next;
 });
 assert.equal(after.metadata.operatorStop.requested,false);assert.equal(preserved(after),preserved(f.state));
 assert.equal(after.decisions.at(-1).context.priorAuthorityDigest,f.state.authorityDigest);
 assert.equal(after.decisions.at(-1).context.priorStopDecisionId,'old-user-stop');
 assert.equal(after.decisions.at(-1).context.userReference,'new-user-event');
});

test('fresh user intent cannot bypass live transport, frozen execution, changed goal or changed Plan',async t=>{
 const f=await setup(t);
 for(const [mutate,code] of [
   [s=>s.leases.push({status:'active'}),'OPERATOR_RESUME_EFFECT_ACTIVE'],
   [s=>s.decisions.push({action:'freeze-execution',decision:'approved'}),'USER_RESTART_REQUIRES_NEW_COMMAND'],
   [s=>s.metadata.commandIntent.target='other','CURRENT_USER_COMMAND_SCOPE_MISMATCH'],
   [s=>s.metadata.lifecyclePlanDigest='other','USER_RESTART_PLAN_MISMATCH']]){
   const state=structuredClone(f.state);mutate(state);
   const commandBoundary=f.boundary({issuedAt:new Date().toISOString(),reference:code});
   await assert.rejects(commandBoundary.run({commandId:'fresh-user'},()=>resumeForCurrentUserCommand({state,plan:f.plan,commandBoundary,kernel:f.harness.kernel})),{code});
 }
 assert.equal((await f.harness.authorityStore.read(f.projectId,'run')).authorityDigest,f.state.authorityDigest);
});
