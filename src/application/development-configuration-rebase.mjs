import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {assert} from '../common/errors.mjs';
import {digestJson} from '../common/canonical.mjs';
import {captureWorkspace,diffWorkspaceSnapshots} from '../common/workspace-snapshot.mjs';
import {applyConfiguredFileBoundary,validateFileBoundary} from '../common/configured-file-boundary.mjs';
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
