import { continuousPolicy, executionProblemId, validateContinuousExecution } from '../common/continuous-execution.mjs';

// Project-policy migration creates a new audited view, never rewrites old ledgers.
export const installContinuousAccounting = state => {
  const policy=validateContinuousExecution(continuousPolicy(state));
  if (!policy) return null;
  state.metadata.continuousExecution=policy;
  const installed=[];
  for (const feature of state.features.filter(f=>f.kind!=='execution-diagnostic' && f.state!=='completed')) {
    const problemId=executionProblemId(feature),key=`${feature.logicalRoot}:problem:${problemId}:failure`;
    if(state.attempts[key]) continue;
    const rows=state.submissions.filter(s=>s.featureId===feature.id && s.result.status!=='completed'
      && state.attempts[s.attemptBudgetKey]?.budgetKind!=='progress');
    if(!rows.length) continue;
    const failures=rows.length,limit=policy.recovery.cyclesPerProblem;
    const history=state.submissions.filter(s=>s.featureId===feature.id);
    const lastProgress=history.findLastIndex(s=>s.result.status==='completed'||state.attempts[s.attemptBudgetKey]?.budgetKind==='progress');
    const cycleFailures=history.slice(lastProgress+1).filter(s=>s.result.status!=='completed'&&state.attempts[s.attemptBudgetKey]?.budgetKind!=='progress').length;
    state.attempts[key]={key,logicalRoot:feature.logicalRoot,problemId,budgetKind:'failure',failures,cycleFailures,cycleGeneration:0,limit,
      exhausted:cycleFailures>=limit,records:rows.map(s=>({dispatchId:s.dispatchId,submissionId:s.submissionId,at:s.submittedAt})),
      migratedSubmissionIds:rows.map(s=>s.submissionId)};
    if(feature.state==='failed-budget' && cycleFailures<limit) feature.state='blocked';
    installed.push({featureId:feature.id,problemId,key,failures,limit});
  }
  return installed;
};
