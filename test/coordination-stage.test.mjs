import test from 'node:test';
import assert from 'node:assert/strict';
import {coordinationStage} from '../src/common/coordination-stage.mjs';
import {executionHealth} from '../src/common/execution-health.mjs';
import {executionFault,processFailureRecovery} from '../src/application/execution-fault.mjs';
import {validateBusinessResult} from '../src/platform/execution/result-contract.mjs';
import {isResultCorrection} from '../src/platform/execution/result-correction.mjs';

test('unconfirmed spawns never become running Agents or indefinite waits; verified registration has its own stage',()=>{
 assert.equal(coordinationStage({effect:{state:'spawn-requested'}}).action,'reconcile-effect');
 assert.equal(coordinationStage({lease:{status:'active'}}).action,'inspect-before-waiting');
 assert.equal(coordinationStage({effect:{state:'settled',outcome:{disposition:'result-observed'}},lease:{status:'active'}}).stage,'result-observed');
 assert.equal(coordinationStage({registration:{stage:'verified'}}).stage,'verified-awaiting-registration');
 assert.equal(coordinationStage({registration:{stage:'submitted'},userStopped:true}).stage,'stopped');
});
test('long verified progress continues; unknown exceptions get diagnosis and cannot forge a correction capability',()=>{
 assert.equal(executionHealth({startedAt:0,observedAt:7200000,progress:[{at:7199000,kind:'checkpoint',hostVerified:true,evidenceRef:'actual'}]}).action,'observe');
 assert.equal(executionFault({code:'NEW_INTERNAL_ERROR'}).nextAction,'restricted-diagnosis');
 assert.equal(executionFault({code:'RESOURCE_HOST_HEADROOM_LOW'}).category,'resource');
 assert.equal(isResultCorrection({code:'RESULT_SCHEMA_INVALID'}),false);
 try{validateBusinessResult({status:'completed'});}catch(error){assert(isResultCorrection(error));}
 for(const code of ['UNSEEN_DENIED_ERROR','RESOURCE_SUPERVISOR_UNAVAILABLE','RESOURCE_HOST_HEADROOM_LOW'])assert.equal(processFailureRecovery({executorReceipt:{payload:{environmentError:{code},resourceReceipt:{supervised:true}}}}),'diagnose');
});
