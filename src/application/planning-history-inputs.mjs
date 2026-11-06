import { readVerifiedRunHistory, readVerifiedRunRecord,historyCommandIdentity } from './authority-history-reader.mjs';
import { assert } from '../common/errors.mjs';

/** Read-only decision inputs, never replacement Authority records. Verify every
 * archived record while retaining only fields consumed by these planners. */
export const readImplementationPlanningHistory = async (store, projectId, intent) => {
  const rows=[];
  await readVerifiedRunHistory(store,projectId,{include:state=>{
    const metadata=state.metadata??{},carry=metadata.completionCarryover;
    rows.push({projectId:state.projectId,runId:state.runId,status:state.status,updatedAt:state.updatedAt,
      authorityDigest:state.authorityDigest,sourceDigest:state.sourceDigest,
      features:state.features.map(f=>({state:f.state,metadata:{stage:f.metadata?.stage}})),
      metadata:{commandIntent:historyCommandIdentity(metadata.commandIntent),lifecyclePlanDigest:metadata.lifecyclePlanDigest,
        logicalTaskKey:metadata.logicalTaskKey,supersededByRunId:metadata.supersededByRunId,supersedePlanDigest:metadata.supersedePlanDigest,
        ...(carry?.replacementPlan?{completionCarryover:{replacementPlan:{logicalTaskKey:carry.replacementPlan.logicalTaskKey}}}:{})}});
    return false;
  }});
  // Small in-memory adapters do not expose the persisted reader's include hook.
  if(!rows.length&&!store.runFile)return readVerifiedRunHistory(store,projectId);
  rows.sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const ids=new Set(rows.map(row=>row.runId));
  const pending=rows.filter(row=>{
    const command=row.metadata.commandIntent;
    return row.status==='superseded'&&row.metadata.completionCarryover&&!ids.has(row.metadata.supersededByRunId)
      &&command?.action==='implement'&&command.target===intent.target&&command.workflowId===intent.workflowId&&command.preset===intent.preset;
  });
  assert(pending.length<=1,'CARRYOVER_REPLACEMENT_AMBIGUOUS','More than one retired implementation Run has an unstarted replacement.');
  for(const row of pending) {
    const full=await readVerifiedRunRecord(store,projectId,row.runId);
    assert(full.authorityDigest===row.authorityDigest,'AUTHORITY_HISTORY_CHANGED','Pending carry-over changed during history inspection.');
    rows[rows.indexOf(row)]=full;
  }
  return rows;
};

export const qualityHistoryInput = state => ({
  projectId:state.projectId,runId:state.runId,status:state.status,revision:state.revision,
  authorityDigest:state.authorityDigest,sourceDigest:state.sourceDigest,createdAt:state.createdAt,updatedAt:state.updatedAt,
  metadata:{workflow:state.metadata?.workflow&&{id:state.metadata.workflow.id},commandIntent:historyCommandIdentity(state.metadata?.commandIntent),
    qualityRepairInventories:Object.fromEntries(Object.entries(state.metadata?.qualityRepairInventories??{}).map(([key,value])=>
      [key,{scopeRoot:value.scopeRoot,findings:value.findings?.map(f=>({id:f.id}))}]))},
  features:state.features.map(f=>({id:f.id,state:f.state,metadata:{qualityRoot:f.metadata?.qualityRoot,qualityReview:f.metadata?.qualityReview}})),
  findings:structuredClone(state.findings),
  submissions:state.submissions.map(s=>({featureId:s.featureId,supersededAt:s.supersededAt,outputSourceDigest:s.outputSourceDigest,
    submittedAt:s.submittedAt,evidenceRefs:s.evidenceRefs,result:{status:s.result?.status,
      knownFindingDispositions:s.result?.knownFindingDispositions,deliveryPrerequisites:s.result?.deliveryPrerequisites}})),
});

export const readQualityPlanningHistory = async (store,projectId) => {
  const rows=[];
  await readVerifiedRunHistory(store,projectId,{include:state=>{rows.push(qualityHistoryInput(state));return false;}});
  return rows.sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt)));
};
