import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {makeFixture,startRun,dispatchAndBind,command} from './test-support.mjs';
import {compile,completion} from './delivery-batch-support.mjs';
import {digestJson} from '../src/common/canonical.mjs';
import {recordResultContinuously} from '../src/application/record-result-continuously.mjs';
import {createTestHarness as createHarness} from './lifecycle-command-support.mjs';
import {ResultRegistration,registrationBinding} from '../src/application/result-registration.mjs';

const setup=async t=>{
 const f=await makeFixture();t.after(f.cleanup);
 await mkdir(resolve(f.workspace,'src'));
 await writeFile(resolve(f.workspace,'src/receiver.mjs'),'export const receive=x=>x*2;');
 await writeFile(resolve(f.workspace,'verify.mjs'),"import assert from 'node:assert/strict';import {receive} from './src/receiver.mjs';assert.equal(receive(4),8);console.log('real verification completed');");
 const feature=compile()[0];
 await startRun(f,{features:[feature,compile()[1]]});
 const {dispatch}=await dispatchAndBind(f,'run');
 const result=completion(feature);
 return {...f,dispatch,result};
};

for(const interrupted of ['observed','prechecked','verified','authority-committed'])test(`real check and registration resume after ${interrupted} without another Agent or duplicate Submission`,async t=>{
 const f=await setup(t);let injected=false;const events=[];
 await assert.rejects(f.harness.recordResult(f.projectId,'run',f.dispatch.dispatchId,f.result,{commandId:'same-result',onVerificationProgress:e=>{
   events.push(e);if(e.phase==='result-registration'&&e.stage===interrupted&&!injected){injected=true;throw Error('controlled interruption');}
 }}),/controlled interruption/);
 assert(injected);
 const before=await f.harness.authorityStore.read(f.projectId,'run');const attempts=digestJson(before.attempts);
 const resumed=[];
 const r=await f.harness.recordResult(f.projectId,'run',f.dispatch.dispatchId,f.result,{commandId:'same-result',onVerificationProgress:e=>resumed.push(e)});
 assert.equal(r.state.features[0].state,'completed');assert.equal(r.state.submissions.length,1);
 assert.equal(r.state.dispatches.length,1);assert.equal(digestJson(r.state.attempts),attempts);
 if(interrupted==='verified')assert(resumed.some(e=>e.stage==='verified'&&e.retained===true));
 if(interrupted==='authority-committed')assert.equal(r.reused,true);
 const again=await f.harness.recordResult(f.projectId,'run',f.dispatch.dispatchId,f.result,{commandId:'same-result'});
 assert.equal(again.reused,true);assert.equal(again.state.revision,r.state.revision);
});

test('retained verification refuses source drift or a substituted native result',async t=>{
 const f=await setup(t);
 await assert.rejects(f.harness.recordResult(f.projectId,'run',f.dispatch.dispatchId,f.result,{commandId:'retain',onVerificationProgress:e=>{
   if(e.stage==='verified')throw Error('controlled interruption');
 }}),/controlled interruption/);
 await writeFile(resolve(f.workspace,'src/receiver.mjs'),'export const receive=x=>x*3;');
 await assert.rejects(f.harness.recordResult(f.projectId,'run',f.dispatch.dispatchId,f.result,{commandId:'retain'}));
 assert.equal((await f.harness.authorityStore.read(f.projectId,'run')).submissions.length,0);
});

for(const stage of ['verified','authority-committed'])test(`automatic control loop survives ${stage} interruption and advances to the next task`,async t=>{
 const f=await setup(t);let injected=false,recovered=0;
 const outcome=await recordResultContinuously(f.harness,f.projectId,'run',f.dispatch.dispatchId,f.result,{commandId:'automatic',onVerificationProgress:e=>{
   if(e.phase==='result-registration-recovery')recovered++;
   if(e.stage===stage&&!injected){injected=true;throw Error('controlled interruption');}
 }});
 assert(injected);assert.equal(recovered,1);assert.equal(outcome.state.features[0].state,'completed');
 assert.equal(outcome.state.submissions.length,1);assert.equal(outcome.state.dispatches.length,1);
 const next=await dispatchAndBind(f,'run');assert.equal(next.dispatch.featureId,outcome.state.features[1].id);
 const finished=await f.harness.recordResult(f.projectId,'run',next.dispatch.dispatchId,completion(next.dispatch.featureSnapshot),{commandId:'next-task'});
 assert(finished.state.features.every(x=>x.state==='completed'));
});

test('the same unresolved registration fault has a persisted finite recovery allowance',async t=>{
 const f=await setup(t);let attempts=0;
 const execute=()=>recordResultContinuously(f.harness,f.projectId,'run',f.dispatch.dispatchId,f.result,{commandId:'finite',onVerificationProgress:e=>{
   if(e.stage==='verified'){attempts++;throw Error('same persistent fault');}
 }});
 await assert.rejects(execute(),/same persistent fault/);assert.equal(attempts,3);
 await assert.rejects(execute(),/same persistent fault/);assert.equal(attempts,4);
 assert.equal((await f.harness.authorityStore.read(f.projectId,'run')).submissions.length,0);
});

test('a verified checkpoint never overrides a subsequent explicit user stop',async t=>{
 const f=await setup(t);
 await assert.rejects(f.harness.recordResult(f.projectId,'run',f.dispatch.dispatchId,f.result,{commandId:'stop-case',onVerificationProgress:e=>{
   if(e.stage==='verified')throw Error('controlled interruption');
 }}),/controlled interruption/);
 const state=await f.harness.authorityStore.read(f.projectId,'run');
 await f.harness.kernel.recordDecision(f.projectId,'run',{id:'user-stop',action:'stop-execution',actor:'user',decision:'approved',
   context:{projectId:f.projectId,runId:'run',sourceDigest:state.sourceDigest,priorAuthorityDigest:state.authorityDigest}},command(state));
 await assert.rejects(recordResultContinuously(f.harness,f.projectId,'run',f.dispatch.dispatchId,f.result,{commandId:'stop-case'}),{code:'OPERATOR_EXECUTION_STOPPED'});
 assert.equal((await f.harness.authorityStore.read(f.projectId,'run')).submissions.length,0);
});

test('a fresh Harness instance resumes persisted Host verification without another check process',async t=>{
 const f=await setup(t);
 await assert.rejects(f.harness.recordResult(f.projectId,'run',f.dispatch.dispatchId,f.result,{commandId:'restart',onVerificationProgress:e=>{
   if(e.stage==='verified')throw Error('controlled coordinator loss');
 }}),/controlled coordinator loss/);
 const fresh=await createHarness({dataRoot:f.dataRoot,strictProjectIdentity:false,releaseIdentity:{version:'1.0.0',artifactDigest:null}});
 const events=[];
 const resumed=await recordResultContinuously(fresh,f.projectId,'run',f.dispatch.dispatchId,f.result,{commandId:'restart',onVerificationProgress:e=>events.push(e)});
 assert.equal(resumed.state.features[0].state,'completed');assert(events.some(e=>e.stage==='verified'&&e.retained));
 assert.equal(resumed.state.submissions.length,1);assert.equal(resumed.state.dispatches.length,1);
});

test('corrupted checkpoint evidence cannot become completion or a recovery allowance',async t=>{
 const f=await setup(t);
 await assert.rejects(f.harness.recordResult(f.projectId,'run',f.dispatch.dispatchId,f.result,{commandId:'corrupt',onVerificationProgress:e=>{
   if(e.stage==='verified')throw Error('controlled interruption');
 }}),/controlled interruption/);
 const state=await f.harness.authorityStore.read(f.projectId,'run'),dispatch=state.dispatches.find(d=>d.dispatchId===f.dispatch.dispatchId);
 const registration=new ResultRegistration({root:f.dataRoot,evidenceStore:f.harness.evidenceStore,
   binding:registrationBinding({state,dispatch,feature:state.features[0],result:f.result,commandId:'corrupt'})});
 const journal=JSON.parse(await readFile(registration.file,'utf8'));
 const hash=journal.evidenceRef.split(':')[1];
 await writeFile(resolve(f.dataRoot,'evidence','sha256',hash.slice(0,2),hash),'corrupted retained evidence');
 await assert.rejects(recordResultContinuously(f.harness,f.projectId,'run',dispatch.dispatchId,f.result,{commandId:'corrupt'}),{code:'EVIDENCE_DIGEST_MISMATCH'});
 assert.equal((await f.harness.authorityStore.read(f.projectId,'run')).submissions.length,0);
});
