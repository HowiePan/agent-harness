import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {validateContinuousExecution,executionProblemId,problemHistory} from '../src/common/continuous-execution.mjs';
import {selectAttemptBudget} from '../src/kernel/attempt-budget.mjs';
import {installContinuousAccounting} from '../src/kernel/continuous-accounting.mjs';
import {resourceClassLimits} from '../src/platform/plugins/execution/resource-policy.mjs';
import {decideInterruption} from '../src/application/interruption-policy.mjs';
import {interruptionContext} from '../src/application/interruption-review.mjs';
import {makeFixture,startRun,feature,dispatchAndBind,recordResult,command} from './test-support.mjs';
import {readScriptPolicyBinding} from '../src/application/script-policy-binding.mjs';
import {runResourceBounded} from '../src/platform/plugins/execution/resource-guard.mjs';

const policy=validateContinuousExecution({version:'continuous-execution/1'});
const blocked={status:'blocked',summary:'Observed deterministic build failure',changedFiles:[],failureClass:'environment',blocker:{kind:'environment',summary:'compiler failed'}};
test('policy requires explicit valid configuration and separates build from helper',()=>{
 assert.equal(validateContinuousExecution(null),null);
 for(const bad of [{version:'unknown'},{version:policy.version,resources:{cpuPercent:100}},{version:policy.version,recovery:{cyclesPerProblem:0}}]) assert.throws(()=>validateContinuousExecution(bad));
 assert.equal(resourceClassLimits(policy,'build').memoryBytes,2*1024**3);
 assert.equal(resourceClassLimits(policy,'helper').memoryBytes,512*1024**2);
 assert.throws(()=>resourceClassLimits(null,'build'),{code:'RESOURCE_POLICY_BINDING_REQUIRED'});
 assert.equal(resourceClassLimits(policy,'helper','stream').maxInputFiles,65536);
});
test('problem identity ignores Run, source and labels; distinct contracts have separate history',()=>{
 const a=feature('a',{}, {logicalRoot:'root'}), b=feature('b',{}, {logicalRoot:'root'});
 assert.equal(executionProblemId(a),executionProblemId({...a,id:'renamed',sourceDigest:'edited',failureClass:'renamed'}));
 assert.notEqual(executionProblemId(a),executionProblemId(b));
 const s={features:[a,b],submissions:[],metadata:{continuousExecution:policy,interruptionLedger:[{logicalRoot:'root',problemId:executionProblemId(a)}]}};
 assert.equal(problemHistory(s,a).length,1);assert.equal(problemHistory(s,b).length,0);
});
test('progress and failures have no cumulative cap; labels cannot mint task identities',()=>{
 const f=feature('owner',{}, {logicalRoot:'root'}),s={features:[f],metadata:{continuousExecution:policy},submissions:[]};
 const sub={result:{...blocked,status:'blocked'},inputSourceDigest:'before',outputSourceDigest:'after',changedFiles:['work/owner/x'],evidenceRefs:['sealed']};
 const progress=selectAttemptBudget({state:s,feature:f,submission:sub,profile:{attemptBudget:()=>({kind:'progress',limit:21})}});
 assert.equal(progress.limit,null);
 const select=result=>selectAttemptBudget({state:s,feature:f,submission:{...sub,result},profile:{}});
 assert.equal(select(blocked).key,select({...blocked,failureClass:'different',blocker:{kind:'another'}}).key);
 assert.equal(select(blocked).limit,null);
});
test('migration keeps original counts and includes previous failed submissions in the new view',()=>{
 const f={...feature('owner',{}, {logicalRoot:'root'}),state:'failed-budget'};
 const old={key:'root:environment',logicalRoot:'root',budgetKind:'failure',failures:1,limit:1,exhausted:true};
 const s={features:[f],metadata:{continuousExecution:policy},attempts:{[old.key]:old},submissions:[{featureId:f.id,submissionId:'old',attemptBudgetKey:old.key,result:blocked}]};
 installContinuousAccounting(s);assert.equal(s.attempts[old.key],old);assert.equal(old.exhausted,true);
 assert.equal(Object.values(s.attempts).find(x=>x.problemId)?.failures,1);assert.equal(f.state,'blocked');
 installContinuousAccounting(s);assert.equal(Object.keys(s.attempts).length,2);
});
test('native diagnosis reservations can serve a new problem after another problem spent its two legacy slots',async t=>{
 const f=await makeFixture({policy:{continuousExecution:policy}});t.after(f.cleanup);
 await startRun(f,{features:[feature('owner',{stage:'implementation'},{logicalRoot:'root'})]});
 const d=await dispatchAndBind(f,'run');const s=(await recordResult(f,'run',d.dispatch,blocked)).state;
 assert.equal(s.metadata.continuousExecution.version,policy.version);
 const context=interruptionContext(s,s.features[0]);assert.equal(context.facts.recoveryLimit,null);
 const decision=decideInterruption({...context,capabilities:[{id:'diagnose',operation:'diagnose',authorized:true,available:true,evidenceBound:true,readOnly:true}]});
 assert.equal(decision.action,'diagnose');
 const r=await f.harness.scheduleInterruptionReview(f.projectId,'run','owner','review');assert.equal(r.state.metadata.interruptionLedger.length,1);
});
test('three failures retain history without exhausting a task; retries still require an explicit reopen',async t=>{
 const f=await makeFixture({policy:{continuousExecution:policy}});t.after(f.cleanup);
 await startRun(f,{features:[feature('owner',{stage:'implementation'},{logicalRoot:'root'})]});
 let s;for(let i=0;i<3;i++){
  const d=await dispatchAndBind(f,'run');s=(await recordResult(f,'run',d.dispatch,{...blocked,failureClass:`label-${i}`})).state;
  if(i<2)s=(await f.harness.kernel.reopenFeature(f.projectId,'run',{featureId:'owner',reason:'test reviewed strategy'},command(s))).state;
 }
 assert.equal(s.features[0].state,'blocked');assert.equal(Object.keys(s.attempts).length,1);
 assert.equal(Object.values(s.attempts)[0].limit,null);
 assert.equal((await dispatchAndBind(f,'run')).dispatch,null);
});
test('verified unique progress opens new windows without deleting lifetime failures',async t=>{
 const f=await makeFixture({profiles:['engine-delivery'],policy:{continuousExecution:policy}});t.after(f.cleanup);
 await f.harness.startRun({projectId:f.projectId,runId:'run',profileId:'engine-delivery',
  profileConfig:{requireCanonicalDecision:false,requireUserCodeReview:false},
  features:[feature('owner',{stage:'implementation',implementationProgressRetries:2},{logicalRoot:'root'})],
  metadata:{attemptAccounting:'separate-progress-v1'},executionAuthorizationEvidence:{explicitUnattended:true}},command());
 await mkdir(resolve(f.workspace,'work/owner'),{recursive:true});
 let s;for(let i=0;i<5;i++){
  let d=await dispatchAndBind(f,'run');s=(await recordResult(f,'run',d.dispatch,blocked)).state;
  s=(await f.harness.kernel.reopenFeature(f.projectId,'run',{featureId:'owner',reason:'reviewed implementation strategy'},command(s))).state;
  d=await dispatchAndBind(f,'run');await writeFile(resolve(f.workspace,'work/owner/result.txt'),`unique implementation ${i}`);
  s=(await recordResult(f,'run',d.dispatch,{status:'blocked',failureClass:'implementation-incomplete',summary:'Source-bound implementation progress',
    changedFiles:['work/owner/result.txt'],blocker:{kind:'in-scope-fix-blocked',summary:'Remaining acceptance'}})).state;
  if(i<4)s=(await f.harness.kernel.reopenFeature(f.projectId,'run',{featureId:'owner',reason:'continue approved work'},command(s))).state;
 }
 const failure=Object.values(s.attempts).find(a=>a.budgetKind==='failure');
 assert.equal(failure.failures,5);assert.equal(failure.cycleFailures,0);assert.equal(failure.cycleGeneration,5);assert.equal(failure.exhausted,false);
 assert.equal(Object.values(s.attempts).find(a=>a.budgetKind==='progress').limit,null);
 assert.equal(s.features[0].state,'blocked');
});
test('extended resources reject missing active Dispatch policy binding',async t=>{
 const f=await makeFixture({policy:{continuousExecution:policy}});t.after(f.cleanup);
 await startRun(f,{features:[feature('owner')]});const d=await dispatchAndBind(f,'run');
 const script=resolve(f.workspace,'work/owner/check.mjs');await mkdir(resolve(script,'..'),{recursive:true});await writeFile(script,'');
 const request={cwd:f.workspace,script,policyBinding:{dataRoot:f.dataRoot,projectId:f.projectId,runId:'run',dispatchId:d.dispatch.dispatchId,packetDigest:'forged'}};
 await assert.rejects(readScriptPolicyBinding(request,resolve('.')),{code:'SCRIPT_POLICY_BINDING_INVALID'});
 request.policyBinding.packetDigest=d.dispatch.packetDigest;
 assert.equal((await readScriptPolicyBinding(request,resolve('.'))).policy.version,policy.version);
});
test('Windows logs spill after display limit, retain exact bytes, and disk overflow still fails',{skip:process.platform!=='win32',timeout:30000},async t=>{
 const f=await makeFixture();t.after(f.cleanup);
 const run=(n,limit)=>runResourceBounded({launch:{executable:process.execPath,args:['-e',`process.stdout.write('x'.repeat(${n}))`],cwd:f.workspace,environment:process.env},limits:{maxOutputBytes:128,maxLogBytes:limit},resourceRoot:resolve(f.root,'resources')});
 const good=await run(4096,8192);assert.equal(good.exitCode,0);assert.equal(good.environmentError,null);
 assert.equal(good.stdout.length,128);assert.equal(good.resourceReceipt.logs.complete,true);
 assert.equal((await readFile(good.resourceReceipt.logs.streams.stdout.path)).length,4096);
 const bad=await run(16384,8192);assert.equal(bad.environmentError.code,'PROCESS_LOG_LIMIT');assert.equal(bad.resourceReceipt.logs.complete,false);
});
