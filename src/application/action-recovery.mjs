import {digestJson} from '../common/canonical.mjs';
import {captureWorkspace} from '../common/workspace-snapshot.mjs';
import {featureContractDigest} from '../common/interruption-contract.mjs';
import {continuousPolicy} from '../common/continuous-execution.mjs';
import {executionFault} from './execution-fault.mjs';
import {assert} from '../common/errors.mjs';

export const ACTION_RECOVERY='action-recovery/1';

/** Facts and operation semantics are supplied by trusted application code, never a worker. */
export const chooseActionRecovery=({facts,mode,history=[],limit=2,sameStrategyFailures=2,continuous=false})=>{
  if(facts.userStopped)return {action:'stop',reason:'user-stop'};
  if(facts.authorizationRequired)return {action:'stop',reason:'authorization'};
  if(facts.contractChange)return {action:'stop',reason:'contract'};
  if(facts.strategyRepeated)return {action:'stop',reason:'no-progress'};
  if(!continuous&&facts.recoveryExhausted)return {action:'stop',reason:'recovery-budget'};
  if(!facts.commandActive)return {action:'stop',reason:'current-command-unavailable'};
  if(!facts.authorityVerified||(!facts.sourceVerified&&mode!=='read')||facts.integrityRisk)
    return {action:'stop',reason:'trusted-state-unresolved'};
  if(facts.committed)return {action:'reconcile',reason:'verified-committed-operation'};
  if(facts.terminal)return {action:'stop',reason:'terminal-run'};
  const window=continuous?history.filter(h=>h.progressDigest===facts.progressDigest):history;
  if(!continuous&&window.length>=limit)return {action:'stop',reason:'recovery-budget'};
  const unchanged=[];
  for(const h of [...window].reverse()){
    if(h.status==='recovered'||h.strategy!==mode||h.outcome!==facts.outcome)break;
    unchanged.push(h);
  }
  if(unchanged.length>=sameStrategyFailures)return {action:'stop',reason:'no-progress'};
  if(mode==='read'||facts.operationBound&&(mode==='atomic'||mode==='checkpoint'))
    return {action:'retry',reason:'verified-operation-semantics'};
  return {action:'stop',reason:'unresolved-effect'};
};

// Observation revisions and recovery records are deliberately not progress.
export const recoveryProgressDigest=(state,target)=>digestJson({
  features:state.features.filter(f=>(!target||f.id===target)&&f.state==='completed'&&f.kind!=='execution-diagnostic')
    .map(f=>[f.id,f.submissionId??null]),
  submissions:[...new Set(state.submissions.filter(s=>(!target||s.featureId===target)&&s.inputSourceDigest!==s.outputSourceDigest
    &&s.changedFiles?.length).map(s=>digestJson([s.featureId,s.outputSourceDigest])))].sort(),
  gates:[...new Set(state.gates.filter(g=>(!target||g.featureId===target)&&g.status==='passed')
    .map(g=>digestJson([g.gateId??g.id,g.specDigest??null,g.sourceDigest??null])))].sort(),
});

/** No lifecycle entry/restart is available here. Each closure is one existing operation. */
export const createActionRecovery=({context,api,plan,onProgress=null})=>{
  const {authorityStore,kernel}=context;
  const evidenceStore=context.evidenceStore??api.evidenceStore;
  const journalKernel=kernel??api.kernel;
  const readState=()=>authorityStore.read(plan.project.id,plan.run.runId,{required:false});
  const inspect=async(error,spec)=>{
    const observed={version:ACTION_RECOVERY,operation:spec.name,mode:spec.mode,code:error.code??'UNKNOWN_ERROR',
      inspected:[],facts:{commandActive:false,authorityVerified:false,sourceVerified:false}};
    try{
      const state=await readState();
      observed.inspected.push('current-authority');
      if(!state)return {observed,state:null};
      observed.facts.authorityVerified=true;
      observed.sourceDigest=state.sourceDigest;
      observed.authorityDigest=state.authorityDigest;
      observed.facts.userStopped=state.metadata?.operatorStop?.requested===true
        ||state.decisions.some(d=>d.action==='freeze-execution'&&d.decision==='approved');
      observed.facts.terminal=['closed','failed','incomplete','superseded'].includes(state.status);
      try{await api.assertCurrentCommandPlan(plan);observed.facts.commandActive=true;}
      catch(boundary){observed.boundaryCode=boundary.code;}
      observed.inspected.push('current-user-command');
      const project=await context.projectRegistry.get(state.projectId);
      const snapshot=await captureWorkspace(state.metadata.workspace.root,{excluded:project.workspace.excluded??[]});
      observed.facts.sourceVerified=snapshot.digest===state.sourceDigest;
      observed.inspected.push('current-workspace-source');
      observed.effects={leases:state.leases.filter(l=>['active','requested'].includes(l.status)).map(l=>l.leaseId),
        dispatches:state.dispatches.filter(d=>['requested','assigned'].includes(d.status)).map(d=>d.dispatchId)};
      observed.inspected.push('authority-effects');
      const target=state.dispatches.find(d=>d.dispatchId===spec.target)?.featureId??spec.target;
      observed.facts.progressDigest=recoveryProgressDigest(state,target);
      const feature=state.features.find(f=>f.id===target);
      observed.problemId=digestJson({projectId:state.projectId,goal:state.metadata?.logicalTaskKey??plan.logicalTaskKey??null,
        operation:spec.name,target:target??null,contract:feature?featureContractDigest(feature):digestJson({
          action:plan.intent.action,target:plan.intent.target,features:plan.run.features??null,stopCondition:plan.stopCondition??null})});
      const fault=executionFault(error,{phase:spec.name});
      observed.facts.userStopped ||= fault.category==='user-stop';
      observed.facts.authorizationRequired=fault.category==='authorization';
      observed.facts.recoveryExhausted=fault.category==='recovery-budget';
      observed.facts.strategyRepeated=fault.category==='no-progress';
      observed.facts.operationBound=Boolean(spec.commandId);
      observed.facts.integrityRisk=['identity','integrity'].includes(fault.category);
      observed.facts.outcome=digestJson({message:error.message,mode:spec.mode,effects:observed.effects});
      const receipt=spec.commandId&&state.commands?.[spec.commandId];
      const before=spec.beforeInvocation;
      observed.facts.committed=Boolean(spec.mode==='atomic'&&receipt
        &&(spec.payload?receipt.payloadDigest===digestJson(spec.payload):before?.receiptAbsent===true
          &&receipt.revision>before.revision&&state.sourceDigest===before.sourceDigest));
      if(observed.facts.committed)observed.committedReceiptDigest=digestJson(receipt);
      return {observed,state,receipt:observed.facts.committed?receipt:null};
    }catch(diagnosticError){observed.inspectionFailure={code:diagnosticError.code??'UNKNOWN_ERROR',message:diagnosticError.message};return {observed,state:null};}
  };
  const record=async(state,body)=>{
    body={...body,originProjectId:state.projectId,originRunId:state.runId};
    const proof=await evidenceStore.put(body,{projectId:state.projectId,runId:state.runId,epoch:state.epoch,generation:state.generation,
      sourceDigest:state.sourceDigest,mediaType:'application/json',labels:['action-recovery']});
    const id=`action-recovery/${digestJson(body)}`;
    const fresh=await readState();
    if(['closed','failed','incomplete','superseded'].includes(fresh.status))return proof.ref;
    if(!fresh.decisions.some(d=>d.id===id))await journalKernel.recordDecision(state.projectId,state.runId,
      {id,actor:'harness',decision:'recorded',kind:'execution-action-recovery',recovery:body,evidenceRef:proof.ref},
      {expectedRevision:fresh.revision,commandId:id});
    return proof.ref;
  };
  const diagnose=async(error,spec)=>{
    const {observed,state,receipt}=await inspect(error,spec);
    const history=(state?.decisions??[]).filter(d=>d.kind==='execution-action-recovery'&&d.recovery.problemId===observed.problemId
      &&d.recovery.action==='retry').map(d=>({...d.recovery,status:state.decisions.findLast(x=>x.kind==='execution-action-recovery'
        &&x.recovery.action==='attempt-result'&&x.recovery.reservationRef===d.evidenceRef)?.recovery.status}));
    const policy=continuousPolicy(state)?.recovery;
    const choice=chooseActionRecovery({facts:observed.facts,mode:spec.mode,history,
      limit:policy?null:2,sameStrategyFailures:policy?.sameStrategyFailures??2,
      continuous:Boolean(policy)});
    const body={...observed,...choice,strategy:spec.mode,outcome:observed.facts.outcome,progressDigest:observed.facts.progressDigest??null,
      sequence:history.length+1,commandId:spec.commandId??null,
      attempts:(state?.decisions??[]).filter(d=>d.kind==='execution-action-recovery'&&d.recovery.problemId===observed.problemId
        &&d.recovery.action==='attempt-result').map(d=>({status:d.recovery.status,reservationRef:d.recovery.reservationRef,evidenceRef:d.evidenceRef}))};
    // Preserve real inspection even if state/evidence storage itself cannot be written.
    if(state&&observed.facts.commandActive&&!observed.facts.terminal)try{body.evidenceRef=await record(state,body);}
    catch(recordError){body.recordFailure={code:recordError.code??'UNKNOWN_ERROR',message:recordError.message};body.action='stop';body.reason='recovery-journal-unavailable';}
    onProgress?.({phase:'action-recovery',recovery:body});
    return {body,state,receipt};
  };
  const run=async(spec,operation)=>{
    assert((!spec.projectId||spec.projectId===plan.project.id)&&(!spec.runId||spec.runId===plan.run.runId),
      'CURRENT_USER_COMMAND_SCOPE_MISMATCH','Recovery cannot execute an operation in another project or Run.');
    let attempt=0,pending=null;
    const finish=async(status,error=null)=>{
      if(!pending)return;
      const state=await readState();
      await record(state,{version:ACTION_RECOVERY,problemId:pending.problemId,operation:spec.name,
        action:'attempt-result',status,reservationRef:pending.evidenceRef,
        ...(error?{code:error.code??'UNKNOWN_ERROR'}:{}),progressDigest:recoveryProgressDigest(state,spec.target)});
      pending=null;
    };
    for(;;){
      let result;
      try{
        if(attempt)await api.assertCurrentCommandState(plan.project.id,plan.run.runId);
        result=await operation(attempt);
      }catch(error){
        try{await finish('failed',error);}catch(journalError){
          error.details={...error.details,actionRecovery:{action:'stop',reason:'recovery-journal-unavailable',
            inspected:[],recordFailure:{code:journalError.code??'UNKNOWN_ERROR'}}};throw error;
        }
        const {body,receipt}=await diagnose(error,spec);
        error.details={...error.details,actionRecovery:body};
        if(body.action==='reconcile')return {state:await readState(),result:receipt.result,receipt,reused:true};
        if(body.action!=='retry')throw error;
        pending=body;attempt++;continue;
      }
      try{await finish('recovered');}
      catch(error){error.details={...error.details,actionRecovery:{action:'stop',reason:'recovery-journal-unavailable',
        operationCompleted:true,inspected:[]}};throw error;}
      return result;
    }
  };
  return {run,diagnose};
};

/** Operation declarations describe effects, not enumerated error codes. */
export const recoveryAwareApi=(api,recovery,authorityStore)=>{
  const atomic=new Set(['reopenFeature','closeRun','scheduleGateDiagnosticReview','recordDecision','recordHeartbeat','dispatch','recordVerifiedGate']);
  const checkpoint=new Set(['scheduleInterruptionReview','applyInterruptionReview','repairVerificationInputBlocker','recordInterruptionDecision']);
  const reads=new Set(['readDispatchPacket','canRecoverNativeInterruption']);
  const wrap=(object,isKernel=false)=>new Proxy(object,{get(target,key){
    if(key==='recoverExecutionAction'&&!isKernel)return recovery.run;
    if(key==='kernel'&&!isKernel)return wrap(target.kernel,true);
    const value=Reflect.get(target,key);
    if(typeof value!=='function')return value;
    const mode=atomic.has(key)?'atomic':!isKernel&&checkpoint.has(key)?'checkpoint':!isKernel&&reads.has(key)?'read':null;
    if(!mode)return value.bind(target);
    return (...args)=>{
      const last=args.at(-1),commandId=typeof last==='string'?last:last?.commandId;
      const payload=mode==='atomic'&&isKernel?args[2]:null;
      const spec={name:`${isKernel?'kernel':'application'}.${key}`,mode,commandId,payload,
        projectId:args[0],runId:args[1],
        target:typeof args[2]==='string'?args[2]:args[2]?.featureId??null};
      return recovery.run(spec,async retry=>{
        const next=[...args];
        if(!retry&&mode==='atomic'&&!payload){
          const state=await authorityStore.read(args[0],args[1]);
          spec.beforeInvocation={revision:state.revision,sourceDigest:state.sourceDigest,receiptAbsent:!state.commands?.[commandId]};
        }
        if(retry&&last&&typeof last==='object'&&Object.hasOwn(last,'expectedRevision')){
          const state=await authorityStore.read(args[0],args[1]);
          next[next.length-1]={...last,expectedRevision:state.revision};
        }
        return value.apply(target,next);
      });
    };
  }});
  return wrap(api);
};
