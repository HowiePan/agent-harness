import { digestJson, sha256,withoutKeys } from '../common/canonical.mjs';
import { assert } from '../common/errors.mjs';
import { featureContractDigest } from '../common/interruption-contract.mjs';
import { submissionAttempt } from '../kernel/attempt-budget.mjs';
import { createDispatchResultContract } from '../platform/execution/result-contract.mjs';
import { DELIVERY_VERIFICATION_HANDOFF } from '../platform/execution/delivery-verification-ready.mjs';
import { collectImplementationDraftInputs } from './implementation-evidence-inputs.mjs';
import { resolveVerificationInputs } from './verification-input-bindings.mjs';

const code = 'DEVELOPMENT_COORDINATION_REVIEW_INVALID';
const supported = ['approved-host-pre-submission-check-capability', 'pinned-retirement-evidence-input'];
const preparedReviews = new WeakMap();

/** Legacy coordination prerequisites require observed capabilities, never a worker's renamed blocker. */
export const inspectRestoredCoordination = async ({ state, feature, authorityStore, evidenceStore, excluded = [] }) => {
  const submission = state.submissions.findLast(item => item.featureId === feature?.id && !item.supersededAt);
  const prerequisites = submission?.result?.deliveryPrerequisites ?? [];
  const checks = feature?.metadata?.deliveryBatch?.checks ?? [];
  assert(state.metadata?.commandIntent?.action === 'implement' && ['blocked','failed-budget'].includes(feature?.state)
    && !state.metadata?.operatorStop?.requested
    && !(state.decisions ?? []).some(item => item.action === 'freeze-execution' && item.decision === 'approved')
    && !state.leases.some(item => ['requested','active'].includes(item.status))
    && !state.dispatches.some(item => ['requested','assigned'].includes(item.status))
    && submission?.result?.status === 'blocked' && submission.result.failureClass === 'external-prerequisite'
    && submission.result.blocker?.code === 'host-check-order-and-retirement-evidence-input'
    && submission.outputSourceDigest === state.sourceDigest && submission.evidenceRefs?.length
    && submission.submissionDigest === digestJson(withoutKeys(submission, ['submissionDigest']))
    && prerequisites.length === supported.length && supported.every(id => prerequisites.filter(item => item.id === id).length === 1)
    && checks.length && DELIVERY_VERIFICATION_HANDOFF === 'delivery-verification-ready/1',
  code, 'Only the exact committed legacy coordination blocker may use capability restoration; external approvals and dependencies remain blocked.');
  const contract = createDispatchResultContract(feature, {conversationVisible:true});
  assert(contract.version === '1.3', code, 'The replacement Runtime must expose the verification-readiness contract.');
  const drafts = await collectImplementationDraftInputs({state,feature,authorityStore,evidenceStore});
  assert(drafts.length, code, 'The required unaccepted draft Evidence is still unavailable.');
  const bindings=[];
  for(const check of checks) {
    const binding = await resolveVerificationInputs({check,workspaceRoot:state.metadata.workspace.root,
      allowedPaths:feature.allowedPaths,forbiddenPaths:feature.forbiddenPaths,excluded});
    assert(!binding.missingInputs.length, code, 'Required original check inputs are still missing.');
    bindings.push({checkId:check.id,approvedCheckDigest:binding.approvedCheckDigest,effectiveCheckDigest:binding.effectiveCheckDigest});
  }
  return {kind:'delivery-coordination-capability-review',version:'1.0',projectId:state.projectId,runId:state.runId,
    expectedRevision:state.revision,featureId:feature.id,sourceDigest:state.sourceDigest,submissionDigest:submission.submissionDigest,
    contractDigest:featureContractDigest(feature),blockerDigest:digestJson(submission.result.blocker),
    capabilities:supported,verificationHandoff:DELIVERY_VERIFICATION_HANDOFF,resultContractDigest:contract.contractDigest,
    checks:bindings,draftInputs:drafts.map(item=>({evidenceRef:item.evidenceRef,resultDigest:item.resultDigest,evidenceSha256:item.evidenceSha256})),
    acceptanceGranted:false,budgetUnchanged:true};
};

// Inspect ancestry before expanding a replacement graph. Keep only the small
// observed proof in-process; never accept a caller-supplied capability claim.
export const prepareDevelopmentCoordinationReview = async options => {
  const feature=options.state.features.find(item=>item.id===options.review.featureId);
  const actual=await inspectRestoredCoordination({...options,feature,excluded:options.project.workspace.excluded??[]});
  preparedReviews.set(options.state,{actual,authorityDigest:options.state.authorityDigest});
};

export const reviewDevelopmentCoordination = async ({state,project,review,carryover,authorityStore,evidenceStore}) => {
  const feature=state.features.find(item=>item.id===review.featureId);
  const prepared=preparedReviews.get(state);
  const actual=prepared?.authorityDigest===state.authorityDigest?prepared.actual:
    await inspectRestoredCoordination({state,feature,authorityStore,evidenceStore,excluded:project.workspace.excluded??[]});
  const submission=state.submissions.findLast(item=>item.featureId===feature?.id&&!item.supersededAt);
  assert(actual.expectedRevision===state.revision&&actual.sourceDigest===state.sourceDigest
    &&actual.submissionDigest===submission?.submissionDigest&&actual.contractDigest===featureContractDigest(feature)
    &&actual.blockerDigest===digestJson(submission.result.blocker)&&!state.metadata?.operatorStop?.requested
    &&!(state.decisions??[]).some(item=>item.action==='freeze-execution'&&item.decision==='approved')
    &&!state.leases.some(item=>['requested','active'].includes(item.status))
    &&!state.dispatches.some(item=>['requested','assigned'].includes(item.status)),code,'Prepared capability proof changed before recovery.');
  assert(review.kind==='delivery-coordination-review' && review.actor==='operator'
    && Object.keys(review).every(key=>['kind','actor','projectId','runId','featureId','expectedRevision','sourceDigest','submissionDigest','contractDigest','blockerDigest'].includes(key))
    && ['projectId','runId','featureId','expectedRevision','sourceDigest','submissionDigest','contractDigest','blockerDigest'].every(key=>review[key]===actual[key])
    && carryover.firstPendingFeatureId===feature.id,code,'Coordination review must bind the exact idle frontier and replacement plan.');
  const attempt=submissionAttempt(state,feature,state.submissions.findLast(item=>item.featureId===feature.id));
  assert(attempt&&!attempt.exhausted&&!Object.values(state.attempts).some(item=>item.logicalRoot===feature.logicalRoot&&item.exhausted),code,
    'Capability restoration does not waive exhausted budgets; approve the exact bounded addition first.');
  const proof=await evidenceStore.put(actual,{projectId:state.projectId,runId:state.runId,epoch:state.epoch,generation:state.generation,
    featureId:feature.id,sourceDigest:state.sourceDigest,artifactDigest:state.artifactDigest,policyDigest:state.policyDigest,
    labels:['coordination-capability-review']});
  return {...review,kind:'delivery-coordination-resolution',priorAuthorityDigest:state.authorityDigest,
    carryoverDigest:carryover.carryoverDigest,replacementRunId:carryover.replacementRunId,evidenceRef:proof.ref,capabilityDigest:digestJson(actual)};
};

export const inspectDevelopmentCoordinationReview = async (state,authorityStore,evidenceStore) => {
  const transfer=state.metadata?.completionCarryover;
  if(!transfer?.progressOnly||!transfer.priorRunId)return [];
  const prior=await authorityStore.read(state.projectId,transfer.priorRunId);
  const carried=prior.metadata?.completionCarryover;
  const review=carried?.environmentReview;
  if(review?.kind!=='delivery-coordination-resolution')return [];
  const feature=state.features.find(item=>item.id===review.featureId&&item.state==='blocked');
  const submission=state.submissions.findLast(item=>item.featureId===review.featureId&&!item.supersededAt);
  assert(feature&&submission&&prior.status==='superseded'&&prior.metadata.supersededByRunId===state.runId
    && prior.authorityDigest===transfer.priorAuthorityDigest&&review.runId===prior.runId&&review.replacementRunId===state.runId
    && carried.plan.carryoverDigest===review.carryoverDigest&&review.carryoverDigest===transfer.carryoverDigest
    && carried.plan.priorAuthorityDigest===review.priorAuthorityDigest&&review.sourceDigest===state.sourceDigest
    && review.submissionDigest===submission.submissionDigest&&review.contractDigest===featureContractDigest(feature)
    && review.blockerDigest===digestJson(submission.result.blocker),code,'Restored capability receipt does not bind the transferred blocker.');
  const record=await evidenceStore.read(review.evidenceRef);
  const body=JSON.parse(record.bytes.toString('utf8'));
  assert(digestJson(body)===review.capabilityDigest&&record.metadata.runId===prior.runId
    && record.metadata.projectId===state.projectId&&record.metadata.featureId===feature.id
    && record.metadata.sourceDigest===state.sourceDigest&&body.kind==='delivery-coordination-capability-review'
    && body.acceptanceGranted===false&&body.budgetUnchanged===true,code,'Capability restoration is not acceptance or a budget reset.');
  return [review];
};

/** A later H3 patch may refresh an unstarted claim, never drop its review. */
export const rebindDevelopmentCoordinationReview = async ({prior,carryover,evidenceStore}) => {
  const old=prior.metadata.completionCarryover.environmentReview;
  assert(old?.kind==='delivery-coordination-resolution'&&old.carryoverDigest===prior.metadata.completionCarryover.plan.carryoverDigest,
    code,'A pending environment review requires its explicit refresh adapter.');
  const feature=prior.features.find(f=>f.id===old.featureId);
  const submission=prior.submissions.findLast(s=>s.featureId===feature?.id&&!s.supersededAt);
  const record=await evidenceStore.read(old.evidenceRef),body=JSON.parse(record.bytes.toString('utf8'));
  assert(digestJson(body)===old.capabilityDigest&&record.metadata.projectId===prior.projectId&&record.metadata.runId===prior.runId
    &&record.metadata.featureId===feature?.id&&record.metadata.sourceDigest===prior.sourceDigest
    &&record.metadata.epoch===prior.epoch&&record.metadata.generation===prior.generation
    &&body.acceptanceGranted===false&&body.budgetUnchanged===true&&body.sourceDigest===prior.sourceDigest
    &&old.submissionDigest===submission?.submissionDigest&&old.contractDigest===featureContractDigest(feature)
    &&old.blockerDigest===digestJson(submission.result.blocker)
    &&body.resultContractDigest===createDispatchResultContract(feature,{conversationVisible:true}).contractDigest,
    code,'Pending restoration cannot survive a changed source, contract, submission or verification protocol.');
  for(const input of body.draftInputs)assert(sha256((await evidenceStore.read(input.evidenceRef)).bytes)===input.evidenceSha256,
    code,'Pending restoration draft Evidence changed.');
  for(const check of feature.metadata.deliveryBatch.checks){
    const binding=await resolveVerificationInputs({check,workspaceRoot:prior.metadata.workspace.root,
      allowedPaths:feature.allowedPaths,forbiddenPaths:feature.forbiddenPaths});
    assert(!binding.missingInputs.length&&body.checks.some(c=>c.approvedCheckDigest===binding.approvedCheckDigest
      &&c.effectiveCheckDigest===binding.effectiveCheckDigest),code,'Pending restoration check inputs changed.');
  }
  return {...old,priorAuthorityDigest:prior.authorityDigest,carryoverDigest:carryover.carryoverDigest,
    replacementRunId:carryover.replacementRunId,reboundFrom:{carryoverDigest:old.carryoverDigest,replacementRunId:old.replacementRunId}};
};
