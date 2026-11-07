import test from 'node:test';
import assert from 'node:assert/strict';
import {taskFailureStreak,correctionStreak,reviewedStrategyDigest} from '../src/common/task-repetition.mjs';
import {chooseActionRecovery} from '../src/application/action-recovery.mjs';
import {decideInterruption} from '../src/application/interruption-policy.mjs';
import {qualityReviewBudgetExhausted} from '../src/flow-kit/profiles/quality-budget.mjs';

const policy={version:'continuous-execution/1',recovery:{sameStrategyFailures:2}};
test('distinct tasks, outcomes and verified progress never spend a workflow quota',()=>{
 const feature={id:'owner',task:{objective:'Finish retained behavior'}};
 const row=(id,summary,strategy='a')=>({featureId:id,recoveryStrategyDigest:strategy,result:{status:'blocked',blocker:{summary}}});
 const s={metadata:{continuousExecution:policy},attempts:{},submissions:[...Array.from({length:40},(_,i)=>row('other',String(i))),row('owner','missing tool'),row('owner','new defect')]};
 assert.equal(taskFailureStreak(s,feature),1);
 s.submissions.push(row('owner','new defect'));assert.equal(taskFailureStreak(s,feature),2);
 s.submissions.push({...row('owner','fixed'),attemptBudgetKey:'progress'});s.attempts.progress={budgetKind:'progress'};
 assert.equal(taskFailureStreak(s,feature),0);
 assert.equal(qualityReviewBudgetExhausted({...s,profile:{config:{qualityReviewLimit:{mode:'bounded',maxRechecks:0}}},features:[{metadata:{qualityReview:true}}]}),false);
});
test('strategy prose and IDs cannot evade repetition, but concrete evidence and work can differ',()=>{
 const v={evidence:[{path:'source',sha256:'a'}],repairPaths:['source'],remainingWork:[{work:'initial'}]};
 assert.equal(reviewedStrategyDigest(v),reviewedStrategyDigest({...v,reason:'renamed',remainingWork:[{work:'rewritten prose'}]}));
 assert.notEqual(reviewedStrategyDigest(v),reviewedStrategyDigest({...v,evidence:[{path:'source',sha256:'b'}]}));
});
test('diagnostic feedback has an independent consecutive streak and no six-action limit',()=>{
 const assessment={issues:[{code:'INPUT_DISCOVERY_INVALID',path:'catalog'}]};
 const s={decisions:Array.from({length:12},(_,i)=>({kind:'execution-intervention-assessment',featureId:'owner',disposition:'correction-required',assessment:{issues:[{code:'DEFECT',path:String(i)}]}}))};
 s.decisions.push({kind:'execution-intervention-assessment',featureId:'owner',disposition:'correction-required',assessment});
 assert.equal(correctionStreak(s,{id:'owner'},assessment),1);
 s.decisions.push({kind:'execution-intervention-assessment',featureId:'owner',disposition:'correction-required',
   assessment:{issues:[{...assessment.issues[0],actionId:'renamed'}]}});
 assert.equal(correctionStreak(s,{id:'owner'},assessment),2,'Renaming an action does not correct the same defect.');
 const input={problem:{logicalRoot:'root'},facts:{continuous:true,identityTrusted:true},history:Array.from({length:12},()=>({logicalRoot:'root'})),
   capabilities:[{id:'review',operation:'diagnose',authorized:true,available:true,evidenceBound:true,readOnly:true}]};
 assert.equal(decideInterruption(input).action,'diagnose');
 assert.equal(decideInterruption({...input,facts:{...input.facts,diagnosticCorrectionVerified:true,correctionRepeated:true}}).category,'no-progress');
});
test('coordination counts repeated failed outcomes, not successful recoveries or unrelated errors',()=>{
 const facts={commandActive:true,authorityVerified:true,sourceVerified:true,progressDigest:'same',outcome:'current'};
 const history=Array.from({length:20},(_,i)=>({strategy:'read',progressDigest:'same',outcome:String(i),status:'failed'}));
 assert.equal(chooseActionRecovery({facts,mode:'read',continuous:true,history}).action,'retry');
 const failed={strategy:'read',progressDigest:'same',outcome:'current',status:'failed'};
 assert.equal(chooseActionRecovery({facts,mode:'read',continuous:true,history:[...history,failed,failed]}).reason,'no-progress');
 assert.equal(chooseActionRecovery({facts,mode:'read',continuous:true,history:[...history,failed,{...failed,status:'recovered'}]}).action,'retry');
});
