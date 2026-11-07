import {digestJson} from './canonical.mjs';

// An audited task/strategy/outcome, never the number of actions in a workflow.
export const failureOutcome = result => digestJson({
  summary:result.blocker?.summary??result.summary??null,
  paths:[...(result.blocker?.repairCandidatePaths??[])].sort(),
});
const sorted=items=>[...items].sort((a,b)=>digestJson(a).localeCompare(digestJson(b)));
export const reviewedStrategyDigest = value => digestJson({paths:sorted(value.repairPaths??[]),evidence:sorted(value.evidence??[]),
  actions:sorted((value.resolutionActions??[]).map(a=>({kind:a.kind,paths:sorted(a.paths??[]),owner:a.ownerFeatureId??null,
    candidates:sorted(a.admission?.candidates??a.discovery?.inputs??[])})))});
export const taskFailureStreak = (state,feature,strategy=null) => {
  let signature=null,count=0;
  for(const s of [...state.submissions].reverse()){
    if(s.featureId!==feature.id||s.supersededAt)continue;
    if(s.result.status==='completed'||state.attempts?.[s.attemptBudgetKey]?.budgetKind==='progress')break;
    const review=state.decisions?.find(d=>d.kind==='execution-intervention'&&d.strategyDigest===s.recoveryStrategyDigest&&d.featureId===feature.id);
    const current=review?.recommendation?reviewedStrategyDigest(review.recommendation):s.recoveryStrategyDigest??digestJson(feature.task??{});
    if(strategy&&current!==strategy)break;
    const key=digestJson([current,failureOutcome(s.result)]);
    if(signature&&key!==signature)break;
    signature=key;count++;
  }
  return count;
};

// Corrections have their own feedback streak. A different validation defect
// cannot spend another task's allowance; identical feedback cannot loop forever.
export const correctionStreak = (state,parent,assessment) => {
  const signature=a=>digestJson(sorted((a?.issues??[]).map(({code,path})=>({code:code??null,path:path??null}))));
  const wanted=signature(assessment);let count=0;
  for(const d of [...state.decisions].reverse()){
    if(d.kind!=='execution-intervention-assessment'||d.featureId!==parent.id)continue;
    if(d.disposition!=='correction-required'||signature(d.assessment)!==wanted)break;
    count++;
  }
  return count;
};
