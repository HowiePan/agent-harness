import {digestJson,withoutKeys} from '../common/canonical.mjs';
import {assert} from '../common/errors.mjs';
import {featureContractDigest} from '../common/interruption-contract.mjs';
import {continuousPolicy,executionBudgetBlocked,executionProblemId,problemCycle,stagnantExecutionCycles} from '../common/continuous-execution.mjs';
import {assertFeatureFileAccess} from '../common/project-file-policy.mjs';
import {diffWorkspaceSnapshots} from '../common/workspace-snapshot.mjs';

const inside=(root,path)=>path===root||path.startsWith(`${root}/`);
const latest=(state,id)=>state.submissions.findLast(s=>s.featureId===id&&!s.supersededAt);
const idle=state=>!state.metadata?.operatorStop?.requested
  &&!state.decisions.some(d=>d.action==='freeze-execution'&&d.decision==='approved')
  &&!state.leases.some(l=>['requested','active'].includes(l.status))
  &&!state.dispatches.some(d=>['requested','assigned'].includes(d.status));
const owns=(state,feature,path)=>{
  if(typeof path!=='string'||/[\\:*?]/.test(path)||path.startsWith('/')||path.split('/').some(p=>!p||p==='.'||p==='..'))return false;
  if(!feature.allowedPaths.some(root=>inside(root,path))||feature.forbiddenPaths.some(root=>inside(root,path)))return false;
  try{assertFeatureFileAccess({feature,policy:state.metadata.projectFilePolicy,path});return true;}catch{return false;}
};

/** Select an existing declared dependency, never infer an owner from prose or enlarge a contract. */
export const inspectDependencyRepair = (state,reviewFeatureId) => {
  const policy=continuousPolicy(state),review=state.features.find(f=>f.id===reviewFeatureId);
  const result=review&&latest(state,review.id),spec=review?.metadata?.intervention;
  const source=state.features.find(f=>f.id===spec?.sourceFeatureId),submission=source&&latest(state,source.id);
  const diagnosis=result?.result?.outputs?.diagnosis?.value,paths=diagnosis?.repairPaths;
  if(!policy||!idle(state)||state.metadata?.projectFilePolicy?.mode!=='project-owned'
    ||review?.kind!=='execution-diagnostic'||review.state!=='completed'||review.allowedPaths.length
    ||source?.state!=='blocked'||source.metadata?.stage!=='implementation'
    ||submission?.submissionId!==spec.sourceSubmissionId||submission.result.failureClass!=='scope-blocker'
    ||submission.result.blocker?.kind!=='scope'||diagnosis?.conclusion!=='external-prerequisite'
    ||diagnosis.sourceSubmissionId!==submission.submissionId||diagnosis.contractDigest!==featureContractDigest(source)
    ||spec.sourceDigest!==state.sourceDigest||spec.contractDigest!==featureContractDigest(source)
    ||result.result.status!=='completed'||result.changedFiles.length||result.inputSourceDigest!==state.sourceDigest
    ||result.outputSourceDigest!==state.sourceDigest||!result.evidenceRefs.length
    ||!Array.isArray(paths)||!paths.length||paths.length>64||new Set(paths).size!==paths.length
    ||!paths.every(p=>submission.result.blocker.repairCandidatePaths?.includes(p)))return null;
  const owners=source.dependsOn.map(id=>state.features.find(f=>f.id===id)).filter(f=>
    f?.state==='completed'&&f.metadata?.stage==='implementation'&&f.task
    &&paths.every(p=>owns(state,f,p)));
  if(owners.length!==1)return null;
  const owner=owners[0],completion=latest(state,owner.id);
  if(completion?.result.status!=='completed'||completion.submissionId!==owner.submissionId||!completion.evidenceRefs.length
    ||executionBudgetBlocked(state,owner)||executionBudgetBlocked(state,source)
    ||stagnantExecutionCycles(state,source)>=policy.recovery.stagnantCycles)return null;
  // Reopening invalidates only actual completed transitive consumers; their
  // original contracts and completion evidence remain audit history.
  const downstream=new Set([owner.id]);let changed=true;
  while(changed){changed=false;for(const f of state.features)if(!downstream.has(f.id)&&f.dependsOn.some(id=>downstream.has(id))){downstream.add(f.id);changed=true;}}
  const revalidation=state.features.filter(f=>f.id!==owner.id&&downstream.has(f.id)&&f.state==='completed').map(f=>{
    const accepted=latest(state,f.id);
    return {featureId:f.id,contractDigest:featureContractDigest(f),submissionId:accepted?.submissionId};
  });
  if(revalidation.some(item=>{const f=state.features.find(f=>f.id===item.featureId),s=latest(state,item.featureId);
    return f.metadata?.stage!=='implementation'||s?.result.status!=='completed'||s.submissionId!==f.submissionId||!s.evidenceRefs.length;
  }))return null;
  const problemId=executionProblemId(source),cycleGeneration=problemCycle(state,source),history=state.metadata.dependencyRepairs??[];
  if(history.some(r=>r.reviewSubmissionId===result.submissionId||r.status==='pending')
    ||history.filter(r=>r.problemId===problemId&&r.cycleGeneration===cycleGeneration).length>=policy.recovery.cyclesPerProblem)return null;
  return {version:'dependency-repair/1',id:`dependency-repair/${digestJson({sourceSubmissionId:submission.submissionId,reviewSubmissionId:result.submissionId,owner:owner.id})}`,
    sourceFeatureId:source.id,sourceSubmissionId:submission.submissionId,sourceContractDigest:featureContractDigest(source),
    ownerFeatureId:owner.id,ownerSubmissionId:completion.submissionId,ownerContractDigest:featureContractDigest(owner),
    reviewFeatureId:review.id,reviewSubmissionId:result.submissionId,sourceDigest:state.sourceDigest,
    problemId,cycleGeneration,repairPaths:[...paths],...(revalidation.length?{revalidation}: {})};
};

export const reserveDependencyRepair = async (state,input,evidenceStore,now) => {
  const candidate=inspectDependencyRepair(state,input.reviewFeatureId);
  assert(candidate&&digestJson(candidate)===digestJson(input.candidate),'DEPENDENCY_REPAIR_INVALID','Return requires an idle, source-bound diagnosis and one existing authorized dependency.');
  const decision=state.decisions.find(d=>d.kind==='execution-intervention-assessment'&&d.reviewSubmissionId===candidate.reviewSubmissionId);
  assert(decision?.decision==='verified'&&decision.disposition==='blocked'&&!decision.assessment.issues.length,
    'DEPENDENCY_REPAIR_ASSESSMENT_REQUIRED','Independent diagnosis must have a verified current assessment.');
  const assessment=await evidenceStore.read(decision.evidenceRef),body=JSON.parse(assessment.bytes.toString('utf8'));
  assert(assessment.metadata.projectId===state.projectId&&assessment.metadata.runId===state.runId
    &&body.sourceDigest===state.sourceDigest&&body.reviewSubmissionId===candidate.reviewSubmissionId
    &&body.contractDigest===candidate.sourceContractDigest&&body.disposition==='blocked'&&!body.issues.length,
  'DEPENDENCY_REPAIR_ASSESSMENT_REQUIRED','Return requires the sealed assessment, not a model label.');
  for(const id of [candidate.sourceSubmissionId,candidate.reviewSubmissionId,candidate.ownerSubmissionId,...(candidate.revalidation??[]).map(x=>x.submissionId)]){
    const s=state.submissions.find(s=>s.submissionId===id);
    assert(s?.submissionDigest===digestJson(withoutKeys(s,['submissionDigest'])),'DEPENDENCY_REPAIR_EVIDENCE_INVALID','Submission history changed.');
    for(const ref of s.evidenceRefs){const r=await evidenceStore.read(ref),v=JSON.parse(r.bytes.toString('utf8'));
      assert(r.metadata.projectId===state.projectId&&r.metadata.featureId===s.featureId&&r.metadata.dispatchId===s.dispatchId
        &&r.metadata.sourceDigest===s.inputSourceDigest&&digestJson(v.result)===digestJson(s.result)
        &&v.outputSourceDigest===s.outputSourceDigest,'DEPENDENCY_REPAIR_EVIDENCE_INVALID','Return requires original committed result evidence.');}
  }
  const owner=state.features.find(f=>f.id===candidate.ownerFeatureId),review=state.submissions.find(s=>s.submissionId===candidate.reviewSubmissionId);
  const record={...candidate,status:'pending',assessmentRef:decision.evidenceRef,originRunId:state.runId,reservedAt:now()};
  state.metadata.dependencyRepairs=[...(state.metadata.dependencyRepairs??[]),record];
  owner.state='pending';owner.reopenedAt=now();
  owner.reopenReason=`Repair the existing dependency for ${candidate.sourceFeatureId}. Original completion ${candidate.ownerSubmissionId} is retained only as history and no longer satisfies dependents. Read the exact dependency-repair input. Preserve this complete task, acceptance, checks, ownership and spent budgets. Diagnosis: ${review.result.outputs.diagnosis.value.reason}`;
  for(const item of candidate.revalidation??[]){
    const consumer=state.features.find(f=>f.id===item.featureId);
    consumer.state='pending';consumer.reopenedAt=now();
    consumer.reopenReason=`Dependency repair ${record.id} invalidated completion ${item.submissionId}. Preserve its entire original contract and execute fresh checks after dependencies complete.`;
  }
  return record;
};

/** A corrected handoff may follow committed implementation, without inventing another source edit. */
const priorRepairImplementation = async (state,repair,submission,evidenceStore) => {
  let cursor=repair.sourceDigest;const chain=[];
  for(const item of state.submissions){
    if(item.submissionId===submission.submissionId)break;
    if(item.supersededAt||item.inputSourceDigest===item.outputSourceDigest||item.submittedAt<repair.reservedAt)continue;
    if(item.inputSourceDigest!==cursor)continue;
    assert(item.featureId===repair.ownerFeatureId&&item.submissionId!==repair.ownerSubmissionId
      &&item.submissionDigest===digestJson(withoutKeys(item,['submissionDigest']))&&item.evidenceRefs.length,
    'DEPENDENCY_REPAIR_COMPLETION_INVALID','Repair source history must belong to the authorized dependency.');
    chain.push(item);cursor=item.outputSourceDigest;
  }
  assert(chain.length&&cursor===submission.inputSourceDigest&&cursor===submission.outputSourceDigest
    &&cursor!==repair.sourceDigest,'DEPENDENCY_REPAIR_COMPLETION_INVALID','Repair needs continuous new implementation history.');
  let initial;
  for(const item of chain)for(const ref of item.evidenceRefs){
    const evidence=await evidenceStore.read(ref),body=JSON.parse(evidence.bytes.toString('utf8'));
    assert(evidence.metadata.projectId===state.projectId&&evidence.metadata.featureId===item.featureId
      &&evidence.metadata.dispatchId===item.dispatchId&&evidence.metadata.sourceDigest===item.inputSourceDigest
      &&body.inputSourceDigest===item.inputSourceDigest&&body.outputSourceDigest===item.outputSourceDigest
      &&digestJson(body.result)===digestJson(item.result),'DEPENDENCY_REPAIR_COMPLETION_INVALID','Repair requires original source-bound implementation evidence.');
    if(item===chain[0])initial=body.sourceSnapshotRef;
  }
  const current=state.dispatches.find(d=>d.dispatchId===submission.dispatchId);
  const readSnapshot=async(ref,digest)=>{
    const record=await evidenceStore.read(ref),snapshot=JSON.parse(record.bytes.toString('utf8'));
    assert(record.metadata.projectId===state.projectId&&record.metadata.sourceDigest===digest
      &&snapshot.digest===digest&&snapshot.digest===digestJson(snapshot.files),
    'DEPENDENCY_REPAIR_COMPLETION_INVALID','Repair source inventory is not bound to its evidence.');return snapshot;
  };
  const before=await readSnapshot(initial,repair.sourceDigest),after=await readSnapshot(current?.sourceSnapshotRef,cursor);
  assert(before.root===after.root&&diffWorkspaceSnapshots(before,after).some(path=>repair.repairPaths.includes(path)),
    'DEPENDENCY_REPAIR_COMPLETION_INVALID','Repair paths must retain an actual source change, not a reverted edit.');
  return chain.map(item=>item.submissionId);
};

/** Completion revalidates the dependency; the consumer still owes every original check. */
export const previewDependencyRepairs = (state,submission,now,evidenceStore) =>
  completeDependencyRepairs(structuredClone(state),submission,now,evidenceStore);

export const completeDependencyRepairs = async (state,submission,now,evidenceStore) => {
  const completed=[];
  for(const r of state.metadata.dependencyRepairs??[]){
    const revalidation=r.revalidation?.find(x=>x.featureId===submission.featureId&&!x.verifiedSubmissionId);
    if(revalidation&&submission.result.status==='completed'){
      assert(featureContractDigest(state.features.find(f=>f.id===submission.featureId))===revalidation.contractDigest
        &&submission.submissionId!==revalidation.submissionId,'DEPENDENCY_REPAIR_COMPLETION_INVALID','Revalidation must retain the original dependent contract.');
      revalidation.verifiedSubmissionId=submission.submissionId;
    }
    if(r.status!=='pending'||r.ownerFeatureId!==submission.featureId||submission.result.status!=='completed')continue;
    const owner=state.features.find(f=>f.id===r.ownerFeatureId),source=state.features.find(f=>f.id===r.sourceFeatureId);
    assert(featureContractDigest(owner)===r.ownerContractDigest&&source?.state==='blocked'
      &&featureContractDigest(source)===r.sourceContractDigest&&latest(state,source.id)?.submissionId===r.sourceSubmissionId
      &&submission.submissionId!==r.ownerSubmissionId,
    'DEPENDENCY_REPAIR_COMPLETION_INVALID','Repair needs a new implementation Submission; it cannot reuse the invalidated pass.');
    const implementationSubmissionIds=submission.inputSourceDigest!==submission.outputSourceDigest
      &&submission.changedFiles.some(p=>r.repairPaths.includes(p))?[submission.submissionId]
      :await priorRepairImplementation(state,r,submission,evidenceStore);
    r.status='completed';r.repairSubmissionId=submission.submissionId;r.completedAt=now();
    r.implementationSubmissionIds=implementationSubmissionIds;
    source.state='pending';source.reopenedAt=now();
    source.reopenReason=`Dependency repair ${r.id} completed in ${submission.submissionId}. Recheck the current source and finish the entire original task. All previous consumer proof is stale; request fresh original verification. Remaining external inputs are unresolved until independently verified.`;
    delete source.blocker;completed.push(r.id);
  }
  return completed;
};
