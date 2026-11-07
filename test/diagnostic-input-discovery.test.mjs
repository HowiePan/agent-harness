import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {makeFixture} from './test-support.mjs';
import {sha256} from '../src/common/canonical.mjs';
import {assessDiagnosis} from '../src/application/interruption-diagnosis.mjs';
import {captureWorkspace} from '../src/common/workspace-snapshot.mjs';
import {decideInterruption} from '../src/application/interruption-policy.mjs';

const setup=async t=>{
 const f=await makeFixture();t.after(f.cleanup);await mkdir(resolve(f.workspace,'src'));
 const payload=Buffer.from('certified previous-version input'),input={path:'src/historical.json',sha256:sha256(payload)};
 await writeFile(resolve(f.workspace,input.path),payload);
 const catalog=JSON.stringify({version:'verification-input-catalog/1',inputs:[{...input,version:'previous',purpose:'replay-checkpoint'}]});
 await writeFile(resolve(f.workspace,'src/catalog.json'),catalog);
 const ref={path:'src/catalog.json',sha256:sha256(catalog)},policy={version:'project-files/1',mode:'project-owned',roots:['src'],protectedPaths:['.git']};
 const parent={id:'consumer',allowedPaths:['src'],forbiddenPaths:[],metadata:{deliveryBatch:{sizing:{capacityUnits:10}}}};
 const value={sourceSubmissionId:'original',contractDigest:'a'.repeat(64),conclusion:'external-prerequisite',reason:'Historical input must be located.',evidence:[ref],repairPaths:[],
  resolutionActions:[{id:'historical',kind:'input-discovery',summary:'Locate pinned catalog.',paths:[],discovery:{status:'found',catalogs:[ref],inputs:[input]}}],
  remainingWork:[{work:'Consume historic input',existingImplementation:'Current receiver exists.',remainingDevelopment:'Verify historical behavior.',verification:'Keep all original checks.',units:4,
   unknowns:[{question:'Which input?',classification:'external-prerequisite',action:'Read catalog.',verification:'Original historical checks.',unitsIncluded:true,actionId:'historical'}]}]};
 const assess=async v=>assessDiagnosis({value:v,parent,snapshot:await captureWorkspace(f.workspace),workspaceRoot:f.workspace,
  evidenceStore:f.harness.evidenceStore,evidenceContext:{projectId:f.projectId,runId:'fixture',epoch:1,generation:1},projectFilePolicy:policy});
 return {...f,value,assess,input,ref};
};
test('Host verifies exact catalog and input hashes without granting acceptance or changing checks',async t=>{
 const f=await setup(t),result=await f.assess(f.value);assert.equal(result.disposition,'accepted');
 assert.equal(result.inputDiscoveries[0].completionCredit,false);assert.deepEqual(result.inputDiscoveries[0].inputs,[f.input]);
 for(const mutate of [v=>v.resolutionActions[0].discovery.inputs[0].sha256='0'.repeat(64),
  v=>v.resolutionActions[0].discovery.catalogs[0].sha256='0'.repeat(64),
  v=>v.resolutionActions[0].discovery.inputs[0].path='../escape',
  v=>v.remainingWork[0].unknowns[0].classification='contract-change']){
  const v=structuredClone(f.value);mutate(v);assert.notEqual((await f.assess(v)).disposition,'accepted');
 }
 await writeFile(resolve(f.workspace,'src/historical.json'),'changed');
 assert.equal((await f.assess(f.value)).issues[0].code,'INPUT_DISCOVERY_INVALID');
});
test('pending discovery is a bounded read-only action; unavailable and unrelated prerequisites remain blocked',async t=>{
 const f=await setup(t),v=structuredClone(f.value);v.resolutionActions[0].discovery={status:'pending',catalogs:[],inputs:[]};
 let result=await f.assess(v);assert.equal(result.disposition,'blocked');assert.equal(result.inputDiscoveries[0].status,'pending');
 v.resolutionActions[0].discovery={status:'unavailable',catalogs:[f.ref],inputs:[]};
 result=await f.assess(v);assert.equal(result.disposition,'blocked');assert.equal(result.issues.length,0);
 const found=structuredClone(f.value);found.remainingWork[0].unknowns.push({question:'Other missing authority?',classification:'external-prerequisite',action:'Obtain exact authority.',verification:'Retained check.',unitsIncluded:false});
 assert.equal((await f.assess(found)).disposition,'blocked');
});
test('a verified remaining prerequisite is reported accurately and never overrides user stop or budgets',()=>{
 const input={problem:{logicalRoot:'root',summary:'Missing input'},facts:{identityTrusted:true,recordedPrerequisite:true},history:[],capabilities:[]};
 assert.equal(decideInterruption(input).category,'prerequisite');
 assert.equal(decideInterruption({...input,facts:{...input.facts,userStopped:true}}).category,'user-stop');
 assert.equal(decideInterruption({...input,facts:{...input.facts,budgetExhausted:true}}).category,'budget');
});

test('input verification streams a bounded artifact beyond the catalog size limit',async t=>{
 const f=await setup(t),bytes=Buffer.alloc(2*1024*1024,3),input={path:'src/historical.json',sha256:sha256(bytes)};
 await writeFile(resolve(f.workspace,input.path),bytes);
 const catalog=JSON.stringify({version:'verification-input-catalog/1',inputs:[{...input,version:'prior',purpose:'replay'}]});
 await writeFile(resolve(f.workspace,'src/catalog.json'),catalog);
 const ref={path:'src/catalog.json',sha256:sha256(catalog)},v=structuredClone(f.value);
 v.evidence=[ref];v.resolutionActions[0].discovery={status:'found',catalogs:[ref],inputs:[input]};
 assert.equal((await f.assess(v)).disposition,'accepted');
});

test('input preparation denies unauthenticated candidates, protected paths, uncosted work and changed contracts',async t=>{
 const f=await setup(t),v=structuredClone(f.value);
 v.resolutionActions=[{id:'historical',kind:'input-admission',summary:'Evaluate source candidate.',paths:['src/new-catalog.json'],
   admission:{candidates:[f.ref],work:'Evaluate provenance and independent expected results.',verification:'Keep original historical acceptance.'}}];
 assert.equal((await f.assess(v)).disposition,'accepted');
 for(const change of [x=>x.resolutionActions[0].admission.candidates[0].sha256='0'.repeat(64),
   x=>x.resolutionActions[0].paths=['../other/catalog.json'],x=>x.resolutionActions[0].paths=['.git/catalog.json'],
   x=>x.remainingWork[0].unknowns[0].unitsIncluded=false,x=>x.remainingWork[0].unknowns[0].classification='contract-change']){
   const invalid=structuredClone(v);change(invalid);assert.notEqual((await f.assess(invalid)).disposition,'accepted');
 }
});

test('large optional historical observations are streamed and remain digest observations without acceptance credit',async t=>{
 const f=await setup(t),bytes=Buffer.alloc(2*1024*1024,7);await writeFile(resolve(f.workspace,'src/old.bin'),bytes);
 const v=structuredClone(f.value);v.observations=[{path:'src/old.bin',sha256:sha256(bytes)}];
 const result=await f.assess(v);assert.equal(result.disposition,'accepted');
 assert.equal(result.observations[0].storage,'digest-observation');assert.equal(result.observations[0].acceptanceCredit,false);
 v.observations[0].sha256='0'.repeat(64);assert.equal((await f.assess(v)).issues[0].code,'OBSERVATION_INVALID');
});
