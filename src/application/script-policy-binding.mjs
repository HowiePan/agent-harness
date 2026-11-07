import { resolve, relative } from 'node:path';
import { assert } from '../common/errors.mjs';
import { assertInside } from '../common/paths.mjs';
import { AuthorityStore } from '../kernel/authority-store.mjs';
import { assertFeatureFileAccess } from '../common/project-file-policy.mjs';

// Resolve privileges from immutable control-plane records, not request numbers.
export const readScriptPolicyBinding = async (request,controlRoot) => {
  if(!request.policyBinding) return null;
  const b=request.policyBinding;
  assertInside(controlRoot,resolve(b.dataRoot),'script policy data root');
  const s=await new AuthorityStore({root:b.dataRoot,controlRoot}).read(b.projectId,b.runId);
  const d=s.dispatches.find(x=>x.dispatchId===b.dispatchId);
  const f=s.features.find(x=>x.id===d?.featureId);
  const lease=s.leases.find(x=>x.dispatchId===d?.dispatchId && x.status==='active');
  assert(d?.packetDigest===b.packetDigest && lease && d.status==='assigned'
    && !s.metadata.operatorStop?.requested && resolve(request.cwd)===resolve(s.metadata.workspace.root),
    'SCRIPT_POLICY_BINDING_INVALID','Resource policy requires the current active project Dispatch.');
  assertFeatureFileAccess({feature:f,policy:s.metadata.projectFilePolicy,path:relative(s.metadata.workspace.root,request.script).replaceAll('\\','/'),
    workspaceRoot:s.metadata.workspace.root});
  return {policy:s.metadata.continuousExecution,binding:{projectId:s.projectId,runId:s.runId,dispatchId:d.dispatchId,packetDigest:d.packetDigest}};
};
