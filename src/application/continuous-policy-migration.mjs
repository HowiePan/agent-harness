import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {assert} from '../common/errors.mjs';
import {digestJson,sha256} from '../common/canonical.mjs';
import {validateContinuousExecution,continuousConfigurationDelta} from '../common/continuous-execution.mjs';
import {captureWorkspace,diffWorkspaceSnapshots} from '../common/workspace-snapshot.mjs';

export const inspectContinuousPolicyMigration = async ({state,project,evidenceStore,baselineRef}) => {
 const record=await evidenceStore.read(baselineRef),b=JSON.parse(record.bytes.toString('utf8'));
 const fail='CONTINUOUS_MIGRATION_INVALID';
 assert(['ready','all-remaining-blocked'].includes(state.status) && !state.leases.some(l=>['requested','active'].includes(l.status))
   && record.metadata.projectId===state.projectId && record.metadata.runId===state.runId
   && b.priorAuthorityDigest===state.authorityDigest && b.snapshot.digest===state.sourceDigest
   && digestJson(b.snapshot.files)===state.sourceDigest,fail,'Policy migration needs the exact idle Authority and sealed source inventory.');
 const snapshot=await captureWorkspace(project.workspace.root,{excluded:project.workspace.excluded??[]});
 const configurationText=await readFile(resolve(project.workspace.root,'harness.json'),'utf8');
 const config=JSON.parse(configurationText);
 const {executionPolicy,...remaining}=config.project;
 const policy=validateContinuousExecution(executionPolicy);
 assert(sha256(b.configText??'')===b.snapshot.files.find(f=>f.path==='harness.json')?.sha256,fail,'Original configuration bytes must match the sealed inventory.');
 continuousConfigurationDelta(b.configText,configurationText);
 assert(policy && config.schemaVersion==='1.2'
   && digestJson({...config,schemaVersion:b.config.schemaVersion,project:remaining})===digestJson(b.config)
   && digestJson(diffWorkspaceSnapshots(b.snapshot,snapshot))===digestJson(['harness.json']),fail,
 'Only the explicit execution policy and configuration schema may change; ownership, tasks and approval stay unchanged.');
 return {kind:'continuous-policy-configuration-migration',baselineRef,priorAuthorityDigest:state.authorityDigest,
   fromSourceDigest:state.sourceDigest,toSourceDigest:snapshot.digest,snapshot,policy,configurationPath:'harness.json',configurationText,changedFiles:['harness.json'],acceptanceCredit:false};
};

export const applyContinuousPolicyMigration = async ({kernel,state,project,evidenceStore,baselineRef,commandId,approval}) => {
 const proof=await inspectContinuousPolicyMigration({state,project,evidenceStore,baselineRef});
 assert(approval?.actor==='human-user' && approval.decision==='approved' && approval.action==='enable-continuous-execution'
   && approval.policyDigest===digestJson(proof.policy),'CONTINUOUS_MIGRATION_APPROVAL_REQUIRED','Bind the authorized execution policy explicitly.');
 const stored=await evidenceStore.put(proof,{projectId:state.projectId,runId:state.runId,epoch:state.epoch,generation:state.generation,
   sourceDigest:state.sourceDigest,mediaType:'application/json',labels:['continuous-policy-migration']});
 return kernel.rebaseControlConfiguration(state.projectId,state.runId,{evidenceRef:stored.ref,approval},
   {expectedRevision:state.revision,commandId});
};

export const readContinuousConfigurationBridge = async ({origin,evidenceStore,currentSnapshot,workspaceRoot,configurationText}) => {
 const claim=origin.metadata?.continuousConfigurationRebase;
 if(!claim)return null;
 const record=await evidenceStore.read(claim.evidenceRef),proof=JSON.parse(record.bytes.toString('utf8'));
 const baseline=JSON.parse((await evidenceStore.read(proof.baselineRef)).bytes.toString('utf8'));
 const text=configurationText??await readFile(resolve(workspaceRoot,'harness.json'),'utf8');
 const config=JSON.parse(text);
 const {executionPolicy,...remaining}=config.project;
 assert(record.metadata.projectId===origin.projectId && record.metadata.runId===origin.runId
   && proof.kind==='continuous-policy-configuration-migration' && proof.acceptanceCredit===false
   && proof.fromSourceDigest===claim.fromSourceDigest && proof.toSourceDigest===claim.toSourceDigest
   && baseline.snapshot.digest===proof.fromSourceDigest && digestJson(baseline.snapshot.files)===proof.fromSourceDigest
   && origin.sourceDigest===proof.toSourceDigest && currentSnapshot.digest===proof.toSourceDigest
   && digestJson(proof.snapshot.files)===proof.toSourceDigest
   && sha256(text)===proof.snapshot.files.find(f=>f.path==='harness.json')?.sha256
   && digestJson(diffWorkspaceSnapshots(baseline.snapshot,proof.snapshot))===digestJson(['harness.json'])
   && digestJson(validateContinuousExecution(executionPolicy))===digestJson(proof.policy)
   && digestJson({...config,schemaVersion:baseline.config.schemaVersion,project:remaining})===digestJson(baseline.config)
   && origin.events.some(e=>e.type==='control.configuration-rebased' && e.evidenceRef===claim.evidenceRef),
 'CONTINUOUS_MIGRATION_INVALID','Configuration source bridge must preserve exact source, approval and ownership.');
 return {kind:'configuration-only',fromSourceDigest:proof.fromSourceDigest,toSourceDigest:proof.toSourceDigest,evidenceRef:claim.evidenceRef};
};
