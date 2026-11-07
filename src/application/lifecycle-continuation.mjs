import {resolve} from 'node:path';
import {digestJson,withoutKeys} from '../common/canonical.mjs';
import {assert} from '../common/errors.mjs';
import {safeSegment,assertNoLinkPath} from '../common/paths.mjs';
import {atomicWriteJson,readJson,withDirectoryLock} from '../kernel/atomic-io.mjs';
import {readVerifiedRunRecord} from './authority-history-reader.mjs';
import {opendir} from 'node:fs/promises';
import {assertLifecycleCommandBoundary} from './lifecycle-command-context.mjs';

const verifyMigration=async(root,prior,carry)=>{
 const directory=assertNoLinkPath(root,resolve(root,'development','patches'));
 let match=null;
 for await(const entry of await opendir(directory)){
   if(!entry.isFile()||!entry.name.endsWith('.json'))continue;
   const receipt=await readJson(assertNoLinkPath(root,resolve(directory,entry.name)));
   if(receipt.receiptDigest!==carry.patchReceiptDigest)continue;
   assert(!match&&receipt.kind==='development-patch-receipt'
     &&receipt.receiptDigest===digestJson(withoutKeys(receipt,['receiptDigest']))
     &&['H2','H3','H4'].includes(receipt.level)&&receipt.authorityDecision?.decision==='approved'
     &&(receipt.level!=='H4'||receipt.migrationRunId===prior.runId)
     &&receipt.affectedRuns.some(r=>r.projectId===prior.projectId&&r.runId===prior.runId&&r.revision<prior.revision),
     'LIFECYCLE_CONTINUATION_MIGRATION_INVALID','Continuation requires its original verified migration receipt.');
   match=receipt;
 }
 assert(match&&prior.metadata.supersededReason===`development-${match.level.toLowerCase()}-recovery:${match.receiptDigest}`,
   'LIFECYCLE_CONTINUATION_MIGRATION_INVALID','The original migration receipt is missing or differs from retirement.');
};

/** Continue one sealed replacement, never mint a command intent or expand its goal. */
export const createLifecycleContinuation = async ({authorityStore,evidenceStore,project,plan,priorRunId,commandBoundary}) => {
 assertLifecycleCommandBoundary(commandBoundary);
 const activeCommand=await commandBoundary.assertScope(plan);
 const prior=await readVerifiedRunRecord(authorityStore,project.id,priorRunId);
 const sealed=prior.metadata?.completionCarryover;
 const intent=prior.metadata?.commandIntent;
 assert(prior.status==='superseded'&&/^development-h[234]-recovery:[a-f0-9]{64}$/.test(prior.metadata?.supersededReason??'')
   &&intent?.action==='implement'&&intent.target===plan.intent.target&&plan.intent.action===intent.action
   &&!prior.metadata?.operatorStop?.requested&&!prior.decisions.some(d=>d.action==='freeze-execution'&&d.decision==='approved')
   &&!prior.leases.some(l=>['active','requested'].includes(l.status))&&!prior.dispatches.some(d=>['requested','assigned'].includes(d.status))
   &&prior.metadata.lifecycleInvocationId&&prior.metadata.logicalTaskKey===plan.logicalTaskKey
   &&prior.metadata.supersededByRunId===plan.run.runId&&prior.metadata.supersedePlanDigest===plan.planDigest
   &&sealed?.replacementPlan?.planDigest===plan.planDigest&&digestJson(sealed.replacementPlan)===digestJson(plan)
   &&sealed.plan.replacementRunId===plan.run.runId&&sealed.plan.replacementPlanDigest===plan.planDigest
   &&sealed.plan.sourceDigest===prior.sourceDigest&&plan.run.sourceDigest===prior.sourceDigest
   &&sealed.plan.carryoverDigest===digestJson(withoutKeys(sealed.plan,['carryoverDigest']))
   &&project.id===prior.projectId&&plan.project.id===project.id&&plan.project.descriptorDigest===project.descriptorDigest
   &&plan.run.executionWorkspaceRoot===prior.metadata.workspace.root&&project.workspace.root===prior.metadata.workspace.root,
 'LIFECYCLE_CONTINUATION_SCOPE_INVALID','Continuation requires the original unstopped goal and exact sealed replacement, source and project.');
 await verifyMigration(authorityStore.root,prior,sealed.plan);
 await commandBoundary.acceptSealedReplacement(plan,prior);
 const commandId=`${activeCommand.commandId}.development-continue.${prior.runId}`;
 const body={version:'lifecycle-continuation/1',projectId:project.id,priorRunId,priorAuthorityDigest:prior.authorityDigest,
   originalCommandId:activeCommand.commandId,action:intent.action,target:intent.target,
   runId:plan.run.runId,planDigest:plan.planDigest,logicalTaskKey:plan.logicalTaskKey,
   sourceDigest:prior.sourceDigest,workspaceRoot:plan.run.executionWorkspaceRoot,
   descriptorDigest:project.descriptorDigest,artifactDigest:plan.harness.artifactDigest,
   carryoverDigest:sealed.plan.carryoverDigest,patchReceiptDigest:sealed.plan.patchReceiptDigest,commandId};
 const receipt={...body,receiptDigest:digestJson(body)};
 const existing=await authorityStore.read(project.id,plan.run.runId,{required:false});
 assert(!existing||existing.metadata?.lifecycleInvocationId===commandId&&existing.metadata?.lifecyclePlanDigest===plan.planDigest
   &&!existing.metadata?.operatorStop?.requested,'LIFECYCLE_CONTINUATION_CONFLICT','Replacement already belongs to another command or was stopped.');
 const record=await evidenceStore.put(receipt,{projectId:project.id,runId:priorRunId,epoch:prior.epoch,generation:prior.generation,
   sourceDigest:prior.sourceDigest,createdAt:prior.updatedAt,mediaType:'application/json',labels:['lifecycle-continuation']});
 return {...receipt,evidenceRef:record.ref};
};

export const withLifecycleContinuation = async ({authorityStore,evidenceStore,project,plan,priorRunId,commandBoundary,onProgress=()=>{}},operation) => {
 const receipt=await createLifecycleContinuation({authorityStore,evidenceStore,project,plan,priorRunId,commandBoundary});
 const root=authorityStore.root;
 const file=assertNoLinkPath(root,resolve(root,'lifecycle-continuation',safeSegment(project.id),`${safeSegment(plan.run.runId)}.json`));
 return withDirectoryLock(`${file}.lock`,async()=>{
   const previous=await readJson(file,null);
   assert(!previous||previous.receiptDigest===receipt.receiptDigest&&previous.evidenceRef===receipt.evidenceRef,
     'LIFECYCLE_CONTINUATION_CONFLICT','A continuation reservation cannot be replaced.');
   await commandBoundary.reserveContinuation(plan,await readVerifiedRunRecord(authorityStore,project.id,priorRunId));
   const write=stage=>atomicWriteJson(file,{version:'lifecycle-continuation-progress/1',receiptDigest:receipt.receiptDigest,
     evidenceRef:receipt.evidenceRef,stage,commandId:receipt.commandId},{root});
   // started is a reservation, not evidence that an Agent or Run exists.
   await write('started');onProgress({phase:'lifecycle-continuation',stage:'started',receiptDigest:receipt.receiptDigest});
   const result=await operation(receipt);
   await write('settled');onProgress({phase:'lifecycle-continuation',stage:'settled',status:result.status,receiptDigest:receipt.receiptDigest});
   return result;
 },{root});
};
