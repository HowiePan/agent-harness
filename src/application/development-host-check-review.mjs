import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { digestJson, withoutKeys } from '../common/canonical.mjs';
import { assert } from '../common/errors.mjs';
import { captureWorkspace } from '../common/workspace-snapshot.mjs';
import { featureContractDigest } from '../common/interruption-contract.mjs';
import { submissionAttempt } from '../kernel/attempt-budget.mjs';
import { executionBudgetBlocked } from '../common/continuous-execution.mjs';
import { executeDeliveryCheck } from './delivery-verification.mjs';
import { inspectDevelopmentCoordinationReview } from './development-coordination-review.mjs';

const code = 'DEVELOPMENT_HOST_CHECK_REVIEW_INVALID';
const latest = (state, feature) => state.submissions.findLast(item => item.featureId === feature?.id && !item.supersededAt);
const binds = (review, state, feature, submission) => review?.projectId === state.projectId
  && review.featureId === feature?.id && review.submissionDigest === submission?.submissionDigest
  && review.sourceDigest === state.sourceDigest && review.contractDigest === featureContractDigest(feature)
  && review.blockerDigest === digestJson(submission.result.blocker);

export const selectDevelopmentHostCheck = ({ state, review, carryover, currentSourceDigest }) => {
  const blocked = state.features.filter(feature => feature.state === 'blocked');
  const feature = blocked[0];
  const submission = latest(state, feature);
  assert(state.metadata?.commandIntent?.action === 'implement' && !state.metadata?.operatorStop?.requested
    && !state.decisions.some(item => item.action === 'freeze-execution' && item.decision === 'approved')
    && !state.leases.some(item => ['requested', 'active'].includes(item.status))
    && !state.dispatches.some(item => ['requested', 'assigned'].includes(item.status))
    && blocked.length === 1 && feature.metadata?.stage === 'implementation'
    && carryover.firstPendingFeatureId === feature.id && currentSourceDigest === state.sourceDigest
    && submission?.result.status === 'blocked' && submission.result.failureClass === 'external-prerequisite'
    && submission.result.blocker?.kind === 'permission'
    && digestJson(feature.blocker) === digestJson(submission.result.blocker)
    && submission.submissionDigest === digestJson(withoutKeys(submission, ['submissionDigest']))
    && submission.outputSourceDigest === state.sourceDigest && submission.evidenceRefs?.length,
  code, 'Host review requires one idle, unchanged implementation frontier and its original blocked Submission.');
  const attempt = submissionAttempt(state, feature, submission);
  assert(attempt && !attempt.exhausted
    && !executionBudgetBlocked(state,feature),
  code, 'Host review cannot reset an exhausted budget.');
  assert(review.kind === 'delivery-host-check-review' && review.actor === 'operator'
    && review.runId === state.runId && review.expectedRevision === state.revision
    && Object.keys(review).every(key => ['kind', 'actor', 'projectId', 'runId', 'featureId', 'expectedRevision',
      'submissionDigest', 'sourceDigest', 'contractDigest', 'blockerDigest', 'checkDigest'].includes(key))
    && binds(review, state, feature, submission), code, 'Host review must bind the exact current blocker and contract.');
  const check = feature.metadata.deliveryBatch?.checks.find(item => digestJson(item) === review.checkDigest);
  const prerequisites = submission.result.deliveryPrerequisites ?? [];
  const outputs = feature.metadata.verificationOutputPaths ?? [];
  assert(check?.executionClass === 'deterministic-process' && check.cacheable === false
    && prerequisites.length === 1 && prerequisites[0].classification === 'delivery-prerequisite'
    && prerequisites[0].affectedPaths?.length === 1
    && check.command.slice(1).includes(prerequisites[0].affectedPaths[0])
    && check.inputs.includes(prerequisites[0].affectedPaths[0])
    && check.outputs.length > 0 && check.outputs.every(path => outputs.some(root => path.startsWith(`${root}/`))),
  code, 'Only the exact approved uncached process check with declared transient outputs may resolve its single process prerequisite.');
  return { feature, submission, check };
};

export const reviewDevelopmentHostCheck = async ({ state, project, review, carryover, evidenceStore,
  dataRoot, controlRoot, onProgress, execute = executeDeliveryCheck }) => {
  assert(typeof onProgress === 'function', code, 'Host checks require a live progress observer.');
  const workspaceRoot = state.metadata.workspace.root;
  const excluded = project.workspace.excluded ?? [];
  const currentSourceDigest = (await captureWorkspace(workspaceRoot, { excluded })).digest;
  const { feature, submission, check } = selectDevelopmentHostCheck({ state, review, carryover, currentSourceDigest });
  const sourceContext = { projectId: state.projectId, runId: state.runId, featureId: feature.id,
    dispatchId: submission.dispatchId, epoch: state.epoch, generation: state.generation,
    artifactDigest: state.artifactDigest, policyDigest: state.policyDigest };
  const temporaryDataRoot = resolve(dataRoot, 'verification-tests', 'host-review', randomUUID());
  const receipt = await execute({ check, workspaceRoot, excluded, dataRoot: temporaryDataRoot, controlRoot, evidenceStore,
    inputScope: { allowedPaths: feature.allowedPaths, forbiddenPaths: feature.forbiddenPaths },
    sourceContext, forceFresh: true, onProgress });
  assert(receipt.status === 'passed' && receipt.cacheHit === false && receipt.sourceDrift === false
    && receipt.sourceBefore === state.sourceDigest && receipt.sourceAfter === state.sourceDigest
    && digestJson(receipt.approvedCheck) === review.checkDigest, code, 'The original Host check must pass on the current source.');
  const resolution = { ...review, kind: 'delivery-host-check-resolution', priorAuthorityDigest: state.authorityDigest,
    carryoverDigest: carryover.carryoverDigest, replacementRunId: carryover.replacementRunId,
    evidenceRef: receipt.evidenceRef };
  return resolution;
};

export const inspectDevelopmentHostCheckReview = async (state, authorityStore, evidenceStore) => {
  const transfer = state.metadata?.completionCarryover;
  if (!transfer?.progressOnly || !transfer.priorRunId || !state.features.some(item => item.state === 'blocked')) return [];
  const prior = await authorityStore.read(state.projectId, transfer.priorRunId);
  const carried = prior.metadata?.completionCarryover;
  const review = carried?.environmentReview;
  if (review?.kind === 'delivery-coordination-resolution') return inspectDevelopmentCoordinationReview(state, authorityStore, evidenceStore);
  if (review?.kind !== 'delivery-host-check-resolution') return [];
  const feature = state.features.find(item => item.id === review.featureId && item.state === 'blocked');
  if (!feature) return [];
  const submission = latest(state, feature);
  if (review.submissionDigest !== submission?.submissionDigest || review.sourceDigest !== state.sourceDigest) return [];
  assert(prior.status === 'superseded' && prior.metadata.supersededByRunId === state.runId
    && prior.authorityDigest === transfer.priorAuthorityDigest && review.runId === prior.runId
    && review.replacementRunId === state.runId && review.carryoverDigest === transfer.carryoverDigest
    && carried.plan.carryoverDigest === transfer.carryoverDigest
    && review.priorAuthorityDigest === carried.plan.priorAuthorityDigest
    && binds(review, state, feature, submission) && digestJson(feature.blocker) === review.blockerDigest,
  code, 'Host resolution does not bind the exact transferred blocker.');
  const record = await evidenceStore.read(review.evidenceRef);
  const receipt = JSON.parse(record.bytes.toString('utf8'));
  assert(record.metadata.projectId === state.projectId && record.metadata.runId === prior.runId
    && record.metadata.featureId === feature.id && record.metadata.dispatchId === submission.dispatchId
    && record.metadata.sourceDigest === state.sourceDigest && receipt.kind === 'delivery-verification-receipt'
    && receipt.status === 'passed' && receipt.cacheHit === false && receipt.sourceDrift === false
    && receipt.sourceBefore === state.sourceDigest && receipt.sourceAfter === state.sourceDigest
    && digestJson(receipt.approvedCheck) === review.checkDigest, code, 'Host resolution requires the fresh digest-bound check receipt.');
  return [review];
};
