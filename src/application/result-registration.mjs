import {resolve} from 'node:path';
import {digestJson,withoutKeys} from '../common/canonical.mjs';
import {assert} from '../common/errors.mjs';
import {safeSegment,assertNoLinkPath} from '../common/paths.mjs';
import {atomicWriteJson,readJson,withDirectoryLock} from '../kernel/atomic-io.mjs';
import {executionFault} from './execution-fault.mjs';
import {coordinationStage} from '../common/coordination-stage.mjs';

const stages=['observed','prechecked','verified','submitted'];
/** A progress journal, never an alternative Authority or an acceptance label. */
export class ResultRegistration {
 constructor({root,binding,evidenceStore}){
   this.root=root;this.binding=binding;this.evidenceStore=evidenceStore;
   const directory=resolve(root,'result-registration',safeSegment(binding.projectId),safeSegment(binding.runId));
   this.file=assertNoLinkPath(root,resolve(directory,`${safeSegment(binding.dispatchId)}.${digestJson({commandId:binding.commandId,nativeResultDigest:binding.nativeResultDigest})}.json`));
   this.lockFile=assertNoLinkPath(root,resolve(directory,`${safeSegment(binding.dispatchId)}.lock`));
 }
 async read(){
   const value=await readJson(this.file,null);if(!value)return null;
   assert(value.version==='result-registration/1'&&value.journalDigest===digestJson(withoutKeys(value,['journalDigest']))
     &&digestJson(value.binding)===digestJson(this.binding)&&stages.includes(value.stage),
   'RESULT_REGISTRATION_IDENTITY_MISMATCH','Registration progress must retain the exact native operation and source contract.');
   return value;
 }
 async advance(stage,value){
   const old=await this.read(),index=stages.indexOf(stage);
   assert(index>=0&&(!old?index===0:index<=stages.indexOf(old.stage)+1),
     'RESULT_REGISTRATION_TRANSITION_INVALID','Registration stages must advance in order.');
   if(old&&stages.indexOf(old.stage)>=index)return old;
   const evidence=await this.evidenceStore.put({version:'result-registration-stage/1',binding:this.binding,stage,value},
     {...this.binding,mediaType:'application/json',labels:['result-registration',stage]});
   const body={version:'result-registration/1',binding:this.binding,stage,observation:coordinationStage({registration:{stage}}),evidenceRef:evidence.ref,
     recoveries:old?.recoveries??[],history:[...(old?.history??[]),{stage,evidenceRef:evidence.ref}]};
   const result={...body,journalDigest:digestJson(body)};
   await atomicWriteJson(this.file,result,{root:this.root});return result;
 }
 async value(stage){
   const journal=await this.read(),ref=journal?.history.find(item=>item.stage===stage)?.evidenceRef;
   if(!ref)return null;
   const record=await this.evidenceStore.read(ref),body=JSON.parse(record.bytes.toString('utf8'));
   assert(body.version==='result-registration-stage/1'&&body.stage===stage
     &&digestJson(body.binding)===digestJson(this.binding)
     &&record.metadata.projectId===this.binding.projectId&&record.metadata.runId===this.binding.runId
     &&record.metadata.dispatchId===this.binding.dispatchId&&record.metadata.sourceDigest===this.binding.sourceDigest,
     'RESULT_REGISTRATION_EVIDENCE_INVALID','Registration checkpoint must match its original operation.');
   return body.value;
 }
 async exclusive(operation){return withDirectoryLock(this.lockFile,operation,{root:this.root});}
 async reserveRecovery(error,limit=2){
   return this.exclusive(async()=>{
     const current=await this.read(),fault=executionFault(error,{phase:'registration'});
     if(!current||!['verified','submitted'].includes(current.stage)
       ||!['unclassified','revision'].includes(fault.category))return null;
     const outcome=digestJson({category:fault.category,message:error.message,stage:current.stage});
     let repeated=0;for(const r of [...(current.recoveries??[])].reverse()){
       if(r.outcome!==outcome)break;repeated++;
     }
     if(repeated>=limit)return null;
     const body={...withoutKeys(current,['journalDigest']),recoveries:[...(current.recoveries??[]),{...fault,outcome}]};
     await atomicWriteJson(this.file,{...body,journalDigest:digestJson(body)},{root:this.root});return fault;
   });
 }
}

export const registrationBinding = ({state,dispatch,feature,result,commandId}) => ({
 projectId:state.projectId,runId:state.runId,dispatchId:dispatch.dispatchId,featureId:feature.id,
 epoch:dispatch.epoch,generation:dispatch.generation,packetDigest:dispatch.packetDigest,
 nativeResultDigest:digestJson(result),commandId,sourceDigest:dispatch.sourceDigest,
 artifactDigest:state.artifactDigest??null,policyDigest:state.policyDigest??null,pluginSetDigest:state.pluginSetDigest??null,
 contractDigest:digestJson({task:feature.task,acceptance:feature.acceptance,metadata:feature.metadata}),
});

export const readVerifiedRegistration = async ({registration,resultingSourceDigest,evidenceStore}) => {
 const saved=await registration.value('verified');if(!saved)return null;
 assert(saved.resultingSourceDigest===resultingSourceDigest,'RESULT_REGISTRATION_SOURCE_DRIFT','Source changed after Host verification.');
 for(const receipt of saved.deliveryVerification.receipts){
   const record=await evidenceStore.read(receipt.evidenceRef),body=JSON.parse(record.bytes.toString('utf8'));
   assert(digestJson(body)===digestJson(withoutKeys(receipt,['evidenceRef']))
     &&record.metadata.projectId===registration.binding.projectId&&record.metadata.runId===registration.binding.runId
     &&record.metadata.dispatchId===registration.binding.dispatchId
     &&record.metadata.epoch===registration.binding.epoch&&record.metadata.generation===registration.binding.generation
     &&record.metadata.sourceDigest===resultingSourceDigest
     &&record.metadata.artifactDigest===registration.binding.artifactDigest&&record.metadata.policyDigest===registration.binding.policyDigest&&!body.sourceDrift
     &&body.sourceBefore===resultingSourceDigest&&body.sourceAfter===resultingSourceDigest,
   'RESULT_REGISTRATION_EVIDENCE_INVALID','Checkpoints require original Host receipts and unchanged inputs.');
 }
 return saved.deliveryVerification;
};
