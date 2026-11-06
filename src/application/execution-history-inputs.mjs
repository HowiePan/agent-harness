import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readVerifiedRunHistory,readVerifiedRunRecord,historyCommandIdentity } from './authority-history-reader.mjs';
import { assert } from '../common/errors.mjs';

// This is a verified decision index, never an Authority passed to Kernel.
const header = state => ({projectId:state.projectId,runId:state.runId,status:state.status,revision:state.revision,
  authorityDigest:state.authorityDigest,sourceDigest:state.sourceDigest,updatedAt:state.updatedAt,profile:{id:state.profile?.id},
  metadata:{commandIntent:historyCommandIdentity(state.metadata?.commandIntent),logicalTaskKey:state.metadata?.logicalTaskKey,
    lifecyclePlanDigest:state.metadata?.lifecyclePlanDigest,supersededByRunId:state.metadata?.supersededByRunId,
    supersedePlanDigest:state.metadata?.supersedePlanDigest,supersededReason:state.metadata?.supersededReason,
    planRevision:state.metadata?.planRevision&&{affectedImplementationRuns:state.metadata.planRevision.affectedImplementationRuns},
    ...(state.metadata?.completionCarryover?{completionCarryover:{plan:{
      replacementRunId:state.metadata.completionCarryover.plan?.replacementRunId,
      replacementPlanDigest:state.metadata.completionCarryover.plan?.replacementPlanDigest}}}:{})},
  leases:state.leases.filter(l=>l.status==='active'),
  dispatches:state.dispatches.filter(d=>['requested','assigned'].includes(d.status)||state.leases.some(l=>l.status==='active'&&l.dispatchId===d.dispatchId)),
  features:state.features.map(f=>({id:f.id,state:f.state,metadata:{stage:f.metadata?.stage}})),
  submissions:state.submissions.filter(s=>s.result?.outputs?.['plan-review']).map(s=>({featureId:s.featureId,
    result:{status:s.result.status,outputs:{'plan-review':{value:{approved:s.result.outputs['plan-review'].value?.approved}}}}})),
});

export const readExecutionLineageHistory = async (store,plan) => {
  if(plan.intent.action!=='implement')return readVerifiedRunHistory(store,plan.project.id);
  const rows=[];
  await readVerifiedRunHistory(store,plan.project.id,{include:state=>{rows.push(header(state));return false;}});
  const belongs=row=>row.metadata.logicalTaskKey?row.metadata.logicalTaskKey===plan.logicalTaskKey:
    row.metadata.commandIntent?.action===plan.intent.action&&row.metadata.commandIntent.target===plan.intent.target
      &&(!row.metadata.commandIntent.preset||row.metadata.commandIntent.preset===plan.intent.preset)&&row.profile.id===plan.run.profileId;
  const retired=rows.filter(r=>['failed','incomplete'].includes(r.status)&&belongs(r));
  for(const row of [...rows]) {
    const command=row.metadata.commandIntent;
    const mayApprove=retired.length&&row.status==='closed'&&row.profile.id===plan.run.profileId
      &&['amend','replan'].includes(command?.action)&&command.target===plan.intent.target&&command.workflowId===plan.intent.workflowId
      &&retired.every(r=>row.metadata.planRevision?.affectedImplementationRuns?.some(a=>a.runId===r.runId&&a.revision===r.revision&&a.authorityDigest===r.authorityDigest));
    const carry=row.metadata.completionCarryover?.plan;
    if(!mayApprove&&!(row.status==='superseded'&&carry?.replacementRunId===plan.run.runId&&carry.replacementPlanDigest===plan.planDigest))continue;
    const full=await readVerifiedRunRecord(store,plan.project.id,row.runId);
    assert(full.authorityDigest===row.authorityDigest,'AUTHORITY_HISTORY_CHANGED','Selected execution history changed during preflight.');
    rows[rows.indexOf(row)]=full;
  }
  return rows.sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));
};

export const readActiveLeaseHistory = async store => {
  if(!store.root||!store.runFile)return (await store.listAll()).filter(s=>s.leases.some(l=>l.status==='active'));
  let entries;
  try{entries=await readdir(resolve(store.root,'authority'),{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return [];throw e;}
  const rows=[];
  for(const entry of entries.filter(e=>e.isDirectory()))await readVerifiedRunHistory(store,entry.name,{include:state=>{
    if(state.leases.some(l=>l.status==='active'))rows.push(header(state));return false;
  }});
  return rows;
};
