import {digestJson} from '../common/canonical.mjs';

const protectedCodes=new Map([
 ['OPERATOR_EXECUTION_STOPPED','user-stop'],['WORKSPACE_SOURCE_DRIFT','identity'],
 ['DELIVERY_VERIFICATION_SOURCE_DRIFT','integrity'],['HOST_RESULT_DIGEST_MISMATCH','integrity'],
 ['EVIDENCE_DIGEST_MISMATCH','integrity'],['EVIDENCE_METADATA_INVALID','integrity'],
 ['COMMAND_ID_REUSED','integrity'],['AUTHORITY_DIGEST_MISMATCH','integrity'],
 ...['PROJECT_FILE_OUTSIDE_BOUNDARY','PROJECT_FILE_PROTECTED','FEATURE_READ_ONLY',
   'FEATURE_PATH_NOT_ALLOWED','FEATURE_PATH_FORBIDDEN'].map(code=>[code,'authorization']),
 ['RESOURCE_HOST_HEADROOM_LOW','resource'],['RESOURCE_SUPERVISOR_UNAVAILABLE','capability'],
 ['RESOURCE_SLOT_BUSY','resource-wait'],['REVISION_CONFLICT','revision'],
 ...['CURRENT_USER_COMMAND_REQUIRED','CURRENT_USER_COMMAND_INACTIVE','CURRENT_USER_COMMAND_SCOPE_MISMATCH',
   'CURRENT_USER_COMMAND_ID_MISMATCH','CURRENT_USER_COMMAND_CONTRACT_CHANGED','CURRENT_USER_COMMAND_RUN_CHANGED',
   'CURRENT_USER_COMMAND_LINEAGE_MISMATCH','USER_COMMAND_ALREADY_CONSUMED','LIFECYCLE_COMMAND_NESTING_DENIED',
   'LIFECYCLE_EXECUTION_REENTRY_DENIED','USER_RESTART_REQUIRES_NEW_COMMAND','USER_RESTART_PLAN_MISMATCH'].map(code=>[code,'authorization']),
 ['OPERATOR_RESUME_EFFECT_ACTIVE','identity'],['USER_RESTART_TRANSPORT_UNBOUND','integrity'],
 ['USER_RESTART_CONTAINMENT_UNVERIFIED','integrity'],['USER_RESTART_STOP_LOST','integrity'],
 ['COMMAND_RECOVERY_EXHAUSTED','recovery-budget'],['CURRENT_USER_COMMAND_RUN_STOPPED','authorization'],
 ['COMMAND_ACTION_NO_PROGRESS','no-progress'],
 ['USER_COMMAND_ROLLOUT_CHANGED','identity'],['USER_COMMAND_ROLLOUT_TRUNCATED','integrity'],
]);
/** Control-plane facts only; worker labels never grant a recovery capability. */
export const executionFault = (error,{phase='unknown',origin='undetermined',evidenceRefs=[]}={}) => {
 const category=protectedCodes.get(error?.code)??'unclassified';
 const body={version:'execution-fault/1',phase,origin,code:error?.code??'UNKNOWN_ERROR',category,
   affectedAction:'dependent-action',nextAction:category==='user-stop'?'preserve-and-stop'
     :category==='revision'?'reread-and-reconcile':category==='resource-wait'?'observe-owner'
     :['authorization','recovery-budget'].includes(category)?'preserve-and-await-user-command'
     :['identity','integrity','resource','capability'].includes(category)?'isolate-and-diagnose':'restricted-diagnosis',
   evidenceRefs:[...new Set(evidenceRefs)],userInputRequired:['user-stop','authorization','recovery-budget'].includes(category)};
 return {...body,faultDigest:digestJson(body)};
};

/** Exact compatibility adapter for old process receipts, never substring inference. */
export const processFailureRecovery = receipt => {
 const host=receipt.executorReceipt?.payload,code=host?.environmentError?.code;
 if(receipt.sourceDrift||host?.resourceReceipt?.supervised!==true)return 'diagnose';
 if(code==='RESOURCE_SLOT_BUSY')return 'wait';
 // A supervised, executed command failing its environment may be repaired by its owner.
 if(!host?.environmentError&&Number.isInteger(host?.exitCode))return 'owner-repair';
 if(['ENOENT','EPIPE','ECONNRESET','ETIMEDOUT','PROCESS_SPAWN_FAILED','GATE_PROCESS_TIMEOUT'].includes(code))return 'owner-repair';
 return 'diagnose';
};
