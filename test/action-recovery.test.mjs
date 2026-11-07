import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {makeFixture,startRun,feature,command} from './test-support.mjs';
import {createActionRecovery,recoveryAwareApi,chooseActionRecovery,recoveryProgressDigest} from '../src/application/action-recovery.mjs';
import {carryInterventions} from '../src/kernel/intervention.mjs';
import {digestJson} from '../src/common/canonical.mjs';
import {describeInterruptionError} from '../src/application/interruption-outcome.mjs';

const setup=async t=>{
  const f=await makeFixture();t.after(f.cleanup);
  await startRun(f,{features:[feature('owner')]});
  const plan={project:{id:f.projectId},intent:{action:'run',target:'run'},run:{runId:'run',features:[feature('owner')]}};
  const events=[];
  const api=new Proxy(f.harness,{get(target,key){
    if(key==='assertCurrentCommandPlan')return async()=>{};
    if(key==='assertCurrentCommandState')return async()=>{
      const s=await target.authorityStore.read(f.projectId,'run');
      if(s.metadata.operatorStop?.requested)throw Object.assign(Error('stopped'),{code:'OPERATOR_EXECUTION_STOPPED'});
    };
    return Reflect.get(target,key);
  }});
  const context={authorityStore:f.harness.authorityStore,evidenceStore:f.harness.evidenceStore,
    projectRegistry:f.harness.projectRegistry,kernel:f.harness.kernel};
  const recovery=createActionRecovery({context,api,plan,onProgress:e=>events.push(e)});
  return {...f,plan,context,api,recovery,events};
};
const fault=code=>Object.assign(Error('new failure'),{code});

test('unseen error codes receive actual inspection and a bounded retry without changing contract or counters',async t=>{
  const f=await setup(t),before=await f.harness.authorityStore.read(f.projectId,'run');let calls=0;
  assert.equal(await f.recovery.run({name:'read-input',mode:'read',target:'owner'},async()=>{
    if(!calls++)throw fault('NOT_IN_ANY_REGISTRY');return 42;
  }),42);
  const s=await f.harness.authorityStore.read(f.projectId,'run');
  assert.equal(calls,2);assert.deepEqual(s.attempts,before.attempts);assert.deepEqual(s.features,before.features);
  const records=s.decisions.filter(d=>d.kind==='execution-action-recovery');
  assert.deepEqual(records.map(d=>d.recovery.action),['retry','attempt-result']);
  assert.equal(records[1].recovery.status,'recovered');
  assert(records[0].recovery.inspected.includes('current-workspace-source'));
  await f.harness.evidenceStore.read(records[1].evidenceRef);
});

test('atomic post-commit failure reconciles the exact receipt instead of performing another mutation',async t=>{
  const f=await setup(t);const s=await f.harness.authorityStore.read(f.projectId,'run');
  const input={id:'business-record',actor:'harness',decision:'recorded'};let calls=0;
  const result=await f.recovery.run({name:'kernel.recordDecision',mode:'atomic',commandId:'exact-op',payload:input},async()=>{
    calls++;
    await f.harness.kernel.recordDecision(f.projectId,'run',input,{expectedRevision:s.revision,commandId:'exact-op'});
    throw fault('LOST_RETURN_AFTER_COMMIT');
  });
  assert(result.reused);assert.equal(calls,1);
  assert.equal(result.state.decisions.filter(d=>d.id==='business-record').length,1);
  assert.equal(result.result.decision.id,'business-record');
});

test('stale revisions are refreshed only for the same declared operation and input',async t=>{
  const f=await setup(t),s=await f.harness.authorityStore.read(f.projectId,'run');
  await f.harness.kernel.recordDecision(f.projectId,'run',{id:'other',actor:'harness',decision:'recorded'},command(s));
  const wrapped=recoveryAwareApi(f.api,f.recovery,f.harness.authorityStore);
  const result=await wrapped.kernel.recordDecision(f.projectId,'run',{id:'next',actor:'harness',decision:'recorded'},
    {expectedRevision:s.revision,commandId:'same-business-operation'});
  assert.equal(result.state.decisions.filter(d=>d.id==='next').length,1);
  assert.equal(result.state.features[0].state,'pending');
});

test('relabeling errors and observation revisions cannot reset failed strategy accounting',async t=>{
  const f=await setup(t);let calls=0;
  const execute=()=>f.recovery.run({name:'persistent-input',mode:'read',target:'owner'},async()=>{throw fault(`LABEL_${calls++}`);});
  await assert.rejects(execute(),e=>e.details.actionRecovery.reason==='recovery-budget');
  assert.equal(calls,3);
  const s=await f.harness.authorityStore.read(f.projectId,'run');
  assert.equal(s.decisions.filter(d=>d.recovery?.status==='failed').length,2);
  await assert.rejects(execute(),e=>e.details.actionRecovery.action==='stop');assert.equal(calls,4);
});

test('unknown unsafe effects are inspected without replaying spawn or fabricating an attempted repair',async t=>{
  const f=await setup(t);let calls=0,caught;
  try{await f.recovery.run({name:'host.spawn',mode:'observe'},async()=>{calls++;throw fault('NEW_HOST_ERROR');});}
  catch(error){caught=error;}
  assert.equal(calls,1);assert.equal(caught.details.actionRecovery.reason,'unresolved-effect');
  const result=describeInterruptionError(caught,{plan:f.plan});
  assert.equal(result.diagnosis.attempted[0].action,'inspect');
  assert(result.diagnosis.attempted[0].evidenceRef);
  assert.deepEqual(describeInterruptionError(fault('UNINSPECTED')).diagnosis.attempted,[]);
});

test('stop, identity loss, changed source and reused command IDs never grant a write retry',async t=>{
  for(const condition of ['stop','source','integrity','authorization']){
    const f=await setup(t);let calls=0;
    if(condition==='stop'){
      const s=await f.harness.authorityStore.read(f.projectId,'run');
      await f.harness.kernel.recordDecision(f.projectId,'run',{id:'stop',action:'stop-execution',actor:'user',decision:'approved',
        context:{projectId:f.projectId,runId:'run',sourceDigest:s.sourceDigest,priorAuthorityDigest:s.authorityDigest}},command(s));
    }
    if(condition==='source')await writeFile(resolve(f.workspace,'unexpected.mjs'),'uncommitted');
    const code=condition==='integrity'?'COMMAND_ID_REUSED':condition==='authorization'?'CURRENT_USER_COMMAND_REQUIRED':'NEW_CODE';
    await assert.rejects(f.recovery.run({name:'write',mode:'atomic'},async()=>{calls++;throw fault(code);}));
    assert.equal(calls,1);assert.equal((await f.harness.authorityStore.read(f.projectId,'run')).features[0].state,'pending');
  }
});

test('recovery history transfers with original evidence and no new attempts across replacement identity',async t=>{
  const f=await setup(t);let calls=0;
  await f.recovery.run({name:'read',mode:'read'},async()=>{if(!calls++)throw fault('X');return true;});
  const prior=await f.harness.authorityStore.read(f.projectId,'run');
  const next={...structuredClone(prior),runId:'replacement',decisions:[],evidenceRefs:[]};
  await carryInterventions({state:next,prior,roots:new Set(['owner']),evidenceStore:f.harness.evidenceStore});
  assert.deepEqual(next.decisions,prior.decisions);assert.deepEqual(next.attempts,prior.attempts);
  assert.equal(recoveryProgressDigest(next),recoveryProgressDigest(prior));
  const tampered=structuredClone(prior);tampered.decisions[0].recovery.reason='invented';
  await assert.rejects(carryInterventions({state:{...next,decisions:[]},prior:tampered,roots:new Set(['owner']),evidenceStore:f.harness.evidenceStore}),
    {code:'ACTION_RECOVERY_CARRYOVER_INVALID'});
});

test('progress is independently bounded and new error labels do not identify new problems',()=>{
  const facts={commandActive:true,authorityVerified:true,sourceVerified:true,progressDigest:'after'};
  assert.equal(chooseActionRecovery({facts,mode:'read',limit:6,history:[{strategy:'read',progressDigest:'before'}]}).action,'retry');
  const stalled=[{strategy:'read',progressDigest:'after'},{strategy:'read',progressDigest:'after'}];
  assert.equal(chooseActionRecovery({facts,mode:'read',limit:6,history:stalled}).reason,'no-progress');
  const previous=Array.from({length:8},()=>({strategy:'read',progressDigest:'before'}));
  assert.equal(chooseActionRecovery({facts,mode:'read',continuous:true,limit:6,history:previous}).action,'retry',
    'Verified progress must not become a lifetime interruption cap.');
  assert.equal(chooseActionRecovery({facts,mode:'read',continuous:true,limit:6,history:[...previous,...stalled]}).reason,'no-progress');
  assert.equal(chooseActionRecovery({facts:{...facts,commandActive:false},mode:'read'}).action,'stop');
  const s={features:[],submissions:[],gates:[],dispatches:[]};
  assert.equal(recoveryProgressDigest(s),recoveryProgressDigest({...s,revision:99,decisions:[{id:'observation'}]}));
  const moving={...s,features:[{id:'owner',state:'running'},{id:'diagnosis',kind:'execution-diagnostic',state:'completed'}],
    dispatches:[{dispatchId:'new-observation',status:'assigned'}]};
  assert.equal(recoveryProgressDigest(s),recoveryProgressDigest(moving),'Dispatch or diagnosis churn cannot renew recovery.');
  moving.gates=[{id:'check',status:'passed',sourceDigest:'verified'}];
  assert.notEqual(recoveryProgressDigest(s),recoveryProgressDigest(moving));
  assert.equal(recoveryProgressDigest(moving),recoveryProgressDigest({...moving,gates:[...moving.gates,...moving.gates]}));
  assert.notEqual(digestJson(facts),digestJson({...facts,progressDigest:'before'}));
});
