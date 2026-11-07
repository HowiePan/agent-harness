import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {assert} from '../common/errors.mjs';
import {digestJson,sha256} from '../common/canonical.mjs';
import {captureWorkspace,diffWorkspaceSnapshots} from '../common/workspace-snapshot.mjs';
import {applyConfiguredFileBoundary,validateFileBoundary} from '../common/configured-file-boundary.mjs';
import {readContinuousConfigurationBridge} from './continuous-policy-migration.mjs';
export const readConfigurationSourceBridge = async ({origin,evidenceStore,currentSnapshot,workspaceRoot,projectFilePolicy,configurationText}) => {
  if(origin.metadata?.continuousConfigurationRebase) return readContinuousConfigurationBridge({origin,evidenceStore,currentSnapshot,workspaceRoot,configurationText});
  const claim=origin.metadata?.configurationRebase;
  if(!claim)return null;
  const fail='CONFIGURATION_REBASE_INVALID';
  const record=await evidenceStore.read(claim.evidenceRef),proof=JSON.parse(record.bytes.toString('utf8'));
  const beforeRecord=await evidenceStore.read(proof.baselineRef),baseline=JSON.parse(beforeRecord.bytes.toString('utf8'));
  assert(record.metadata.projectId===origin.projectId&&record.metadata.runId===origin.runId
    &&beforeRecord.metadata.projectId===origin.projectId&&beforeRecord.metadata.runId===origin.runId
    &&proof.kind==='configuration-only-source-rebase'&&proof.acceptanceCredit===false&&claim.acceptanceCredit===false
    &&proof.fromSourceDigest===claim.fromSourceDigest&&proof.toSourceDigest===claim.toSourceDigest
    &&record.metadata.sourceDigest===proof.fromSourceDigest&&beforeRecord.metadata.sourceDigest===proof.fromSourceDigest
    &&baseline.snapshot.digest===proof.fromSourceDigest&&digestJson(baseline.snapshot.files)===proof.fromSourceDigest
    &&proof.snapshot.digest===proof.toSourceDigest&&digestJson(proof.snapshot.files)===proof.toSourceDigest
    &&origin.sourceDigest===proof.toSourceDigest&&currentSnapshot.digest===proof.toSourceDigest
    &&digestJson(diffWorkspaceSnapshots(baseline.snapshot,proof.snapshot))===digestJson(['harness.json']),fail,'Configuration bridge must bind the exact original and current source inventories.');
  const text=configurationText??await readFile(resolve(workspaceRoot,'harness.json'),'utf8');
  assert(sha256(text)===proof.snapshot.files.find(f=>f.path==='harness.json')?.sha256,fail,'Historical configuration bytes must match their sealed inventory.');
  const config=JSON.parse(text);
  validateFileBoundary(config.project.fileBoundary);
  const {fileBoundary,...remaining}=config.project;
  assert(config.schemaVersion==='1.1'&&digestJson({...config,schemaVersion:baseline.config.schemaVersion,project:remaining})===digestJson(baseline.config),fail,'Configuration bridge contains unrelated changes.');
  const next=applyConfiguredFileBoundary({policy:{}},fileBoundary).policy;
  const identity=p=>({version:p.version,mode:p.mode,roots:[...p.roots].sort(),protectedPaths:[...p.protectedPaths].sort()});
  assert(digestJson(identity(next.projectFilePolicy))===digestJson(identity(baseline.policy))
    &&digestJson(identity(projectFilePolicy))===digestJson(identity(baseline.policy))
    &&digestJson(next.qualityVerificationOutputs)===digestJson(baseline.artifactRoots),fail,'Configuration bridge cannot enlarge source or artifact authority.');
  return {kind:'configuration-only',fromSourceDigest:proof.fromSourceDigest,toSourceDigest:proof.toSourceDigest,evidenceRef:claim.evidenceRef};
};
export const inspectPendingConfigurationRebase = async ({prior,project,evidenceStore,baselineRef}) => {
  if(!baselineRef)return null;
  const record=await evidenceStore.read(baselineRef), baseline=JSON.parse(record.bytes.toString('utf8'));
  const fail='CONFIGURATION_REBASE_INVALID';
  assert(prior.status==='superseded' && !prior.features.some(f=>f.state==='completed'&&f.metadata?.stage==='implementation')
    && record.metadata.projectId===prior.projectId&&record.metadata.runId===prior.runId
    && record.metadata.sourceDigest===prior.sourceDigest&&baseline.priorAuthorityDigest===prior.authorityDigest
    && baseline.snapshot.digest===prior.sourceDigest&&digestJson(baseline.snapshot.files)===prior.sourceDigest,fail,'Configuration rebase requires exact sealed partial-only source.');
  const current=await captureWorkspace(project.workspace.root,{excluded:project.workspace.excluded??[]});
  assert(digestJson(diffWorkspaceSnapshots(baseline.snapshot,current))===digestJson(['harness.json']),fail,'Only harness.json may change.');
  const config=JSON.parse(await readFile(resolve(project.workspace.root,'harness.json'),'utf8'));
  validateFileBoundary(config.project.fileBoundary);
  const {fileBoundary,...remaining}=config.project;
  assert(config.schemaVersion==='1.1'&&digestJson({...config,schemaVersion:baseline.config.schemaVersion,project:remaining})===digestJson(baseline.config),fail,'Unrelated configuration changes require independent review.');
  const configured=applyConfiguredFileBoundary({policy:{}},fileBoundary).policy;
  const identity=p=>({version:p.version,mode:p.mode,roots:[...p.roots].sort(),protectedPaths:[...p.protectedPaths].sort()});
  assert(digestJson(identity(configured.projectFilePolicy))===digestJson(identity(baseline.policy))
    &&digestJson(identity(project.policy.projectFilePolicy))===digestJson(identity(baseline.policy))
    &&digestJson(configured.qualityVerificationOutputs)===digestJson(baseline.artifactRoots),fail,'Configuration registration cannot widen effective authority.');
  const proof=await evidenceStore.put({kind:'configuration-only-source-rebase',baselineRef,fromSourceDigest:prior.sourceDigest,toSourceDigest:current.digest,
    changedFiles:['harness.json'],snapshot:current,acceptanceCredit:false},{projectId:prior.projectId,runId:prior.runId,epoch:prior.epoch,generation:prior.generation,sourceDigest:prior.sourceDigest,mediaType:'application/json',labels:['configuration-only-source-rebase']});
  return {evidenceRef:proof.ref,fromSourceDigest:prior.sourceDigest,toSourceDigest:current.digest,acceptanceCredit:false};
};
