import { digestJson } from '../common/canonical.mjs';
import {diagnosticIdentity} from '../common/diagnostic-identity.mjs';
import { assert } from '../common/errors.mjs';
import { submissionAttempt } from './attempt-budget.mjs';
import { validateWorkGraph } from './work-graph.mjs';
import { INTERRUPTION_POLICY, MAX_INTERVENTIONS_PER_ROOT, featureContractDigest, interventionAllowance } from '../common/interruption-contract.mjs';
import { continuousPolicy, executionProblemId, executionBudgetBlocked, problemHistory, problemCycle } from '../common/continuous-execution.mjs';
import {inspectDependencyRepair} from './dependency-repair.mjs';
import {hasMixedPrerequisiteDiagnosis} from './diagnostic-repair-actions.mjs';
import {correctionStreak} from '../common/task-repetition.mjs';

export const INTERVENTION_LIMIT = MAX_INTERVENTIONS_PER_ROOT;
export const isIntervention = feature => feature?.kind === 'execution-diagnostic';
export const isExecutionComplete = feature => feature.state === 'completed'
  || isIntervention(feature) && ['blocked', 'failed-budget', 'cancelled'].includes(feature.state);
export const profileState = state => ({ ...state, features: state.features.filter(feature => !isIntervention(feature)) });

export const carryInterventions = async ({ state, prior, roots, evidenceStore }) => {
  // Recovery accounting belongs to the original goal, not an error label or Run ID.
  for(const d of prior.decisions.filter(d=>d.kind==='execution-action-recovery')){
    const proof=await evidenceStore.read(d.evidenceRef),body=JSON.parse(proof.bytes.toString('utf8'));
    assert(digestJson(body)===digestJson(d.recovery)&&proof.metadata.projectId===prior.projectId
      &&body.originProjectId===prior.projectId&&proof.metadata.runId===body.originRunId,
    'ACTION_RECOVERY_CARRYOVER_INVALID','Recovery accounting requires original evidence, never a caller label.');
    const existing=state.decisions.find(x=>x.id===d.id);
    assert(!existing||digestJson(existing)===digestJson(d),'ACTION_RECOVERY_CARRYOVER_CONFLICT','Recovery history cannot be reset or rewritten.');
    if(!existing)state.decisions.push(structuredClone(d));
    state.evidenceRefs=[...new Set([...state.evidenceRefs,d.evidenceRef])];
  }
  for (const feature of prior.features.filter(item => isIntervention(item))) {
    const binding = feature.metadata?.intervention;
    // H4 installs new diagnostic semantics. Old results remain audit history,
    // not executable assessments or a blocker on a current-policy observation.
    if(continuousPolicy(state)&&binding?.identityVersion!==3)continue;
    const parent = state.features.find(item => item.id === binding?.sourceFeatureId && roots.has(item.logicalRoot));
    if (!parent || binding.sourceDigest !== state.sourceDigest || state.features.some(item => item.id === feature.id)) continue;
    assert(feature.allowedPaths.length === 0 && binding.contractDigest === featureContractDigest(parent)
      && state.metadata.interruptionLedger?.some(item => item.id === feature.id && item.sourceSubmissionId === binding.sourceSubmissionId),
    'INTERVENTION_CARRYOVER_INVALID', 'Diagnostic transfer requires its exact reservation and unchanged parent.');
    const result = feature.submissionId ? prior.submissions.find(item => item.submissionId === feature.submissionId) : null;
    if (result) {
      assert(result.submissionDigest === digestJson(Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'submissionDigest')))
        && result.inputSourceDigest === result.outputSourceDigest && result.outputSourceDigest === state.sourceDigest,
      'INTERVENTION_CARRYOVER_INVALID', 'Transferred diagnostic requires an unchanged read-only Submission.');
      for (const ref of result.evidenceRefs) {
        const evidence = await evidenceStore.read(ref);
        assert(evidence.metadata.projectId === prior.projectId && evidence.metadata.runId === prior.runId
          && evidence.metadata.featureId === feature.id && evidence.metadata.dispatchId === result.dispatchId
          && evidence.metadata.sourceDigest === result.inputSourceDigest,
        'INTERVENTION_CARRYOVER_EVIDENCE', 'Diagnostic transfer must verify the original evidence binding.');
      }
      if(!state.submissions.some(s=>s.submissionId===result.submissionId))state.submissions.push(structuredClone(result));
      state.evidenceRefs = [...new Set([...state.evidenceRefs, ...result.evidenceRefs])];
    }
    assert(['pending', 'completed', 'blocked', 'failed-budget'].includes(feature.state),
      'INTERVENTION_CARRYOVER_ACTIVE', 'Active diagnostic transport cannot transfer.');
    state.features.push(structuredClone(feature));
    const originalParent=prior.features.find(f=>f.id===parent.id);
    const mixed=continuousPolicy(prior)&&prior.metadata.projectFilePolicy?.mode==='project-owned'&&hasMixedPrerequisiteDiagnosis(result?.result)
      &&prior.decisions.some(d=>d.kind==='execution-intervention-assessment'&&d.reviewSubmissionId===result.submissionId
        &&d.sourceSubmissionId===binding.sourceSubmissionId&&d.sourceDigest===state.sourceDigest
        &&(d.disposition==='blocked'&&!d.assessment.issues.length||d.disposition==='correction-required'
          &&d.assessment.issues.some(i=>i.code==='STRUCTURED_RESOLUTION_ACTIONS_REQUIRED')));
    if(originalParent.state==='blocked'&&(inspectDependencyRepair(prior,feature.id)||mixed)){
      parent.state='blocked';parent.blocker=structuredClone(originalParent.blocker);
      parent.submissionId=originalParent.submissionId;
    }
    for (const [key, attempt] of Object.entries(prior.attempts).filter(([, item]) => item.logicalRoot === feature.logicalRoot)) {
      state.attempts[key] = structuredClone(attempt);
    }
  }
  for(const repair of prior.metadata?.dependencyRepairs??[]){
    const source=state.features.find(f=>f.id===repair.sourceFeatureId),owner=state.features.find(f=>f.id===repair.ownerFeatureId);
    if(!source||!owner||!roots.has(source.logicalRoot))continue;
    assert(featureContractDigest(source)===repair.sourceContractDigest&&featureContractDigest(owner)===repair.ownerContractDigest,
      'DEPENDENCY_REPAIR_CARRYOVER_INVALID','Dependency repair cannot transfer to changed contracts.');
    const existing=state.metadata.dependencyRepairs?.find(r=>r.id===repair.id);
    assert(!existing||digestJson(existing)===digestJson(repair),'DEPENDENCY_REPAIR_CARRYOVER_INVALID','Repair history cannot be reset.');
    if(existing)continue;
    for(const id of [repair.sourceSubmissionId,repair.reviewSubmissionId,repair.ownerSubmissionId,...(repair.revalidation??[]).flatMap(x=>[x.submissionId,...(x.verifiedSubmissionId?[x.verifiedSubmissionId]:[])])]){
      const s=prior.submissions.find(s=>s.submissionId===id);
      assert(s?.submissionDigest===digestJson(Object.fromEntries(Object.entries(s).filter(([k])=>k!=='submissionDigest'))),
        'DEPENDENCY_REPAIR_CARRYOVER_INVALID','Repair requires its unchanged Submission lineage.');
      for(const ref of s.evidenceRefs)await evidenceStore.read(ref);
      if(!state.submissions.some(x=>x.submissionId===id))state.submissions.push(structuredClone(s));
      state.evidenceRefs=[...new Set([...state.evidenceRefs,...s.evidenceRefs])];
    }
    await evidenceStore.read(repair.assessmentRef);
    state.metadata.dependencyRepairs=[...(state.metadata.dependencyRepairs??[]),structuredClone(repair)];
    if(repair.status==='pending')for(const current of [source,owner]){
      const old=prior.features.find(f=>f.id===current.id);
      assert(!['running','dispatched'].includes(old.state),'DEPENDENCY_REPAIR_CARRYOVER_INVALID','Active repair cannot transfer.');
      for(const key of ['state','submissionId','blocker','reopenedAt','reopenReason'])if(old[key]!==undefined)current[key]=structuredClone(old[key]);
    }
    // Repair completion does not clear a different, still-recorded prerequisite.
    // Preserve that consumer frontier even when old-source diagnostics cannot transfer.
    if(repair.status==='completed'&&repair.unresolvedPrerequisites?.length){
      const old=prior.features.find(f=>f.id===source.id);
      const submission=prior.submissions.findLast(s=>s.featureId===source.id&&!s.supersededAt);
      if(old.state==='blocked'&&submission?.submissionId===repair.sourceSubmissionId)
        for(const key of ['state','submissionId','blocker','reopenedAt','reopenReason'])
          if(old[key]!==undefined)source[key]=structuredClone(old[key]);
    }
    for(const item of repair.revalidation??[]){
      const current=state.features.find(f=>f.id===item.featureId),old=prior.features.find(f=>f.id===item.featureId);
      assert(current&&featureContractDigest(current)===item.contractDigest,'DEPENDENCY_REPAIR_CARRYOVER_INVALID','Revalidation requires its unchanged dependent contract.');
      if(!item.verifiedSubmissionId)for(const key of ['state','submissionId','blocker','reopenedAt','reopenReason'])if(old[key]!==undefined)current[key]=structuredClone(old[key]);
    }
  }
};

/** Neutral, read-only work reservation. A worker cannot mint execution authority. */
export const reserveIntervention = (state, input, evidence, now) => {
  const source = state.features.find(item => item.id === input.sourceFeatureId);
  assert(!state.metadata?.operatorStop?.requested, 'OPERATOR_EXECUTION_STOPPED', 'The user has stopped this execution.');
  const submission = state.submissions.findLast(item => item.featureId === source?.id && !item.supersededAt);
  assert(source?.state === 'blocked' && !isIntervention(source) && submission?.submissionId === input.sourceSubmissionId
    && submission.outputSourceDigest && submission.evidenceRefs?.length,
  'INTERVENTION_SOURCE_INVALID', 'Diagnostic requires the exact current committed blocker.');
  assert(!state.leases.some(item => ['requested', 'active'].includes(item.status))
    && !state.dispatches.some(item => ['requested', 'assigned'].includes(item.status))
    && !state.decisions.some(item => item.action === 'freeze-execution' && item.decision === 'approved'),
  'INTERVENTION_NOT_IDLE', 'Diagnostic reservation requires idle unfrozen execution.');
  const attempt = submissionAttempt(state, source, submission);
  assert(attempt && (continuousPolicy(state)||!attempt.exhausted) && !executionBudgetBlocked(state,source),
    'INTERVENTION_BUDGET_EXHAUSTED', 'Diagnostics cannot evade exhausted execution budgets.');
  const body = JSON.parse(evidence.bytes.toString('utf8'));
  assert(evidence.metadata.projectId === state.projectId && evidence.metadata.runId === state.runId
    && evidence.metadata.epoch === state.epoch && evidence.metadata.generation === state.generation
    && evidence.metadata.featureId === source.id && evidence.metadata.sourceDigest === state.sourceDigest
    && body.decisionDigest === digestJson(Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'decisionDigest')))
    && body.policy === INTERRUPTION_POLICY && body.action === 'diagnose' && body.problem.submissionId === submission.submissionId
    && body.problem.sourceDigest === state.sourceDigest && body.problem.logicalRoot === source.logicalRoot,
  'INTERVENTION_EVIDENCE_INVALID', 'Reservation must bind a genuine current diagnostic decision.');
  assert(body.problem.contractDigest === featureContractDigest(source), 'INTERVENTION_CONTRACT_MISMATCH', 'Diagnostic must bind the unchanged original contract.');
  const ledger = state.metadata.interruptionLedger ?? [];
  const correctionOf = input.feature.metadata?.intervention?.correctionOf;
  const correction = correctionOf ? state.submissions.find(item => item.submissionId === correctionOf && !item.supersededAt) : null;
  const diagnostic = correction && state.features.find(item => item.id === correction.featureId);
  const assessment = state.decisions.find(item => item.id === body.problem.assessmentId);
  const validCorrection = Boolean(correction && isIntervention(diagnostic) && diagnostic.state === 'completed'
    && correction.result?.status === 'completed' && correction.inputSourceDigest === state.sourceDigest
    && correction.outputSourceDigest === state.sourceDigest && correction.changedFiles.length === 0
    && diagnostic.metadata.intervention.sourceSubmissionId === submission.submissionId
    && ledger.some(item => item.id === diagnostic.id)
    && assessment?.kind === 'execution-intervention-assessment' && assessment.decision === 'verified'
    && assessment.disposition === 'correction-required' && assessment.reviewSubmissionId === correctionOf
    && assessment.sourceSubmissionId === submission.submissionId && assessment.featureId === source.id
    && assessment.sourceDigest === state.sourceDigest && assessment.contractDigest === featureContractDigest(source)
    && body.problem.correctionOf === correctionOf
    && input.feature.metadata.intervention.assessmentId === assessment.id
    && !ledger.some(item => item.correctionOf === correctionOf));
  assert(!correctionOf || validCorrection, 'INTERVENTION_CORRECTION_INVALID', 'Clarification requires the exact unaccepted diagnosis and verified source-bound assessment.');
  const history=problemHistory(state,source);
  assert(!continuousPolicy(state) || body.problem.problemId===executionProblemId(source),'INTERVENTION_PROBLEM_MISMATCH','Problem identity must bind the current contract.');
  assert(body.budget.limit === interventionAllowance(source,state)
    && (continuousPolicy(state) ? !validCorrection||correctionStreak(state,source,assessment.assessment)<continuousPolicy(state).recovery.sameStrategyFailures : history.length < interventionAllowance(source,state))
    && (validCorrection || !history.some(item => item.fingerprint === body.fingerprint)),
  'INTERVENTION_LIMIT_REACHED', 'Repeated unchanged evidence or exhausted recovery allowance cannot create more diagnostics.');
  const candidate = validateWorkGraph([...state.features, input.feature]).at(-1);
  const expectedId=candidate.metadata.intervention?.identityVersion>=2
    ? diagnosticIdentity({root:source.logicalRoot,submissionId:submission.submissionId,sourceDigest:state.sourceDigest,correctionOf})
    : `diagnostic/${digestJson({root:source.logicalRoot,submissionId:submission.submissionId,...(correctionOf?{correctionOf}:{})})}`;
  assert(isIntervention(candidate) && candidate.id === expectedId
    && candidate.allowedPaths.length === 0 && candidate.dependsOn.length === 0 && candidate.gatePlan.length === 0
    && candidate.attemptLimit === 1 && candidate.logicalRoot === `diagnostic:${source.logicalRoot}`
    && candidate.metadata.intervention?.sourceFeatureId === source.id
    && candidate.metadata.intervention.sourceSubmissionId === submission.submissionId
    && candidate.metadata.intervention.sourceDigest === state.sourceDigest
    && candidate.metadata.intervention.contractDigest === body.problem.contractDigest
    && candidate.metadata.intervention.decisionRef === input.evidenceRef,
  'INTERVENTION_FEATURE_INVALID', 'A diagnostic must be a single-attempt read-only task for the bound blocker.');
  state.features.push(candidate);
  state.metadata.interruptionLedger = [...ledger, { id: candidate.id, logicalRoot: source.logicalRoot,
    sourceDigest: state.sourceDigest, ...(continuousPolicy(state)?{problemId:executionProblemId(source),cycleGeneration:problemCycle(state,source)}:{}), fingerprint: body.fingerprint, action: 'diagnose',
    sourceSubmissionId: submission.submissionId, ...(correctionOf ? { correctionOf, assessmentId: assessment.id } : {}),
    evidenceRefs: [input.evidenceRef], reservedAt: now() }];
  return { featureId: candidate.id, scheduled: true };
};

export const assertInterventionReadOnly = (feature, input, dispatch) => {
  if (!isIntervention(feature)) return;
  assert(input.result.changedFiles.length === 0 && input.resultingSourceDigest === dispatch.sourceDigest,
    'INTERVENTION_SOURCE_WRITE_DENIED', 'Diagnostics must preserve the exact workspace source and cannot accept source writes.');
};
