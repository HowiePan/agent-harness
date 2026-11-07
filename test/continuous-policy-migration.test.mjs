import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {makeFixture,startRun,feature,dispatchAndBind,recordResult} from './test-support.mjs';
import {captureWorkspace} from '../src/common/workspace-snapshot.mjs';
import {digestJson,sha256} from '../src/common/canonical.mjs';
import {applyConfiguredFileBoundary} from '../src/common/configured-file-boundary.mjs';
import {validateContinuousExecution} from '../src/common/continuous-execution.mjs';
import {inspectContinuousPolicyMigration,applyContinuousPolicyMigration,readContinuousConfigurationBridge} from '../src/application/continuous-policy-migration.mjs';
import {assessRecoveredImplementationContinuation,assessVerifiedImplementationContinuation} from '../src/application/plan-source-compatibility.mjs';

test('policy configuration migration preserves submissions, history and completion and rejects unrelated edits',async t=>{
 const f=await makeFixture();t.after(f.cleanup);
 const boundary={version:'project-boundary/1',sourceRoots:['work'],sharedPaths:[],artifactRoots:['.local'],protectedPaths:[]};
 const file=resolve(f.workspace,'harness.json'),config={schemaVersion:'1.1',project:{input:{id:'project'},fileBoundary:boundary}};
 await writeFile(file,JSON.stringify(config));
 await startRun(f,{features:[feature('owner',{stage:'implementation'})]});
 const d=await dispatchAndBind(f,'run');
 await mkdir(resolve(f.workspace,'work/owner'),{recursive:true});await writeFile(resolve(f.workspace,'work/owner/implementation.mjs'),'export const implemented=true;');
 let s=(await recordResult(f,'run',d.dispatch,{status:'blocked',changedFiles:['work/owner/implementation.mjs'],summary:'environment',failureClass:'environment',blocker:{kind:'environment',summary:'build failed'}})).state;
 const snapshot=await captureWorkspace(f.workspace),history=digestJson(s.submissions),attempts=digestJson(s.attempts);
 const b=await f.harness.evidenceStore.put({snapshot,config,configText:JSON.stringify(config),priorAuthorityDigest:s.authorityDigest},
   {projectId:f.projectId,runId:'run',sourceDigest:s.sourceDigest,epoch:s.epoch,generation:s.generation,mediaType:'application/json'});
 const project=await f.harness.projectRegistry.get(f.projectId),policy=validateContinuousExecution({version:'continuous-execution/1'});
 const next={...config,schemaVersion:'1.2',project:{...config.project,executionPolicy:policy}};
 await writeFile(file,JSON.stringify(next));
 const input={state:s,project,evidenceStore:f.harness.evidenceStore,baselineRef:b.ref};
 assert.equal((await inspectContinuousPolicyMigration(input)).acceptanceCredit,false);
 await writeFile(file,JSON.stringify({...next,project:{...next.project,input:{id:'other'}}}));
 await assert.rejects(inspectContinuousPolicyMigration(input),{code:'CONTINUOUS_MIGRATION_INVALID'});
 await writeFile(file,JSON.stringify(next));
 await writeFile(resolve(f.workspace,'unexpected.txt'),'source edit');
 await assert.rejects(inspectContinuousPolicyMigration(input),{code:'CONTINUOUS_MIGRATION_INVALID'});
 const {unlink}=await import('node:fs/promises');await unlink(resolve(f.workspace,'unexpected.txt'));
 s=(await applyContinuousPolicyMigration({...input,kernel:f.harness.kernel,commandId:'policy-migrate',approval:{actor:'human-user',decision:'approved',action:'enable-continuous-execution',policyDigest:digestJson(policy)}})).state;
 assert.equal(digestJson(s.submissions),history);assert.equal(digestJson(s.attempts),attempts);
 assert.equal(s.metadata.continuousExecution,null); // no hot patch to the old Run
 const bridgeInput={origin:s,evidenceStore:f.harness.evidenceStore,currentSnapshot:await captureWorkspace(f.workspace),workspaceRoot:f.workspace};
 assert.equal((await readContinuousConfigurationBridge(bridgeInput)).fromSourceDigest,snapshot.digest);
 const binding={runId:'approved-plan',planDigest:'approved-digest',artifactDigest:'approved-artifact',originalSourceDigest:'reviewed',sourceDigest:d.dispatch.sourceDigest};
 const origin={...s,metadata:{...s.metadata,approvedPlan:binding,commandIntent:{action:'implement',target:'fixture'},workflow:{id:'delivery'}}};
 const admission={planRun:{projectId:s.projectId,runId:binding.runId,sourceDigest:'reviewed',metadata:{commandIntent:{target:'fixture'},workflow:{id:'delivery'}}},
   planArtifact:binding,priorRuns:[origin],currentSnapshot:bridgeInput.currentSnapshot,currentSourceDigest:s.sourceDigest,
   workspaceRoot:f.workspace,implementationFeatures:s.features,evidenceStore:f.harness.evidenceStore};
 assert.equal(assessVerifiedImplementationContinuation(admission),null);
 assert.equal((await assessRecoveredImplementationContinuation(admission)).mode,'verified-implementation-with-configuration-rebase');
 // A second configuration transition must not erase the historical bridge.
 const atDispatch=JSON.parse((await f.harness.evidenceStore.read(d.dispatch.sourceSnapshotRef)).bytes.toString('utf8'));
 const historicalConfig={schemaVersion:'1.0',project:{input:{id:'project'}}},historicalText=JSON.stringify(historicalConfig);
 const beforeFiles=atDispatch.files.map(row=>row.path==='harness.json'?{...row,sha256:sha256(historicalText),size:Buffer.byteLength(historicalText)}:row);
 const before={...atDispatch,files:beforeFiles,digest:digestJson(beforeFiles)};
 const filePolicy=applyConfiguredFileBoundary({policy:{}},boundary).policy.projectFilePolicy;
 const context={projectId:s.projectId,runId:'legacy-configuration',sourceDigest:before.digest,epoch:1,generation:1,mediaType:'application/json'};
 const legacyBaseline=await f.harness.evidenceStore.put({snapshot:before,config:historicalConfig,policy:filePolicy,artifactRoots:['.local']},context);
 const legacyBody={kind:'configuration-only-source-rebase',baselineRef:legacyBaseline.ref,fromSourceDigest:before.digest,toSourceDigest:atDispatch.digest,snapshot:atDispatch,acceptanceCredit:false};
 const legacyProof=await f.harness.evidenceStore.put(legacyBody,context);
 const legacy={...origin,runId:context.runId,sourceDigest:atDispatch.digest,submissions:[],metadata:{...origin.metadata,
  continuousConfigurationRebase:undefined,configurationRebase:{evidenceRef:legacyProof.ref,fromSourceDigest:before.digest,toSourceDigest:atDispatch.digest,acceptanceCredit:false}}};
 origin.metadata.approvedPlan={...binding,sourceDigest:before.digest};legacy.metadata.approvedPlan=origin.metadata.approvedPlan;
 admission.projectFilePolicy=filePolicy;
 assert.equal(await assessRecoveredImplementationContinuation(admission),null);
 admission.priorRuns=[origin,legacy];
 assert.equal((await assessRecoveredImplementationContinuation(admission)).submissionDigests.length,1);
 const wrong={...legacy,metadata:{...legacy.metadata,configurationRebase:{...legacy.metadata.configurationRebase,evidenceRef:s.metadata.continuousConfigurationRebase.evidenceRef}}};
 await assert.rejects(assessRecoveredImplementationContinuation({...admission,priorRuns:[origin,wrong]}),{code:'CONFIGURATION_REBASE_INVALID'});
 await assert.rejects(readContinuousConfigurationBridge({...bridgeInput,currentSnapshot:{digest:'forged'}}),{code:'CONTINUOUS_MIGRATION_INVALID'});
});
