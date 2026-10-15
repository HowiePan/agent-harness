import { assert } from '../../common/errors.mjs';
import { defineNodeTaskContract, taskFeatureProjection } from '../../common/task-contract.mjs';
import { reviewedPlanProposal } from './plan-approval.mjs';

export const DEFAULT_PLAN_REVIEW_LIMIT = 6;

const withTaskFeedback = (task, { id, path, description, instruction }) => {
  const { taskDigest: _digest, ...body } = task;
  return taskFeatureProjection(defineNodeTaskContract({
    ...body,
    instructions: [...body.instructions, instruction],
    inputs: [...body.inputs, { id, source: 'feature', path, required: true, description }],
  }));
};

// A negative independent review is evidence for another planning attempt in
// the same Run. No review result is promoted to approval by this continuation.
export const createPlanReviewFollowUps = ({ state, feature, result }) => {
  if (feature.metadata?.stage !== 'plan-review' || result.status !== 'completed') return [];
  const review = result.outputs?.['plan-review']?.value;
  if (review?.approved !== false) return [];
  const round = feature.metadata.planReviewRound ?? 1;
  if (round >= state.profile.config.planReviewLimit) return [];
  const plan = reviewedPlanProposal(state);
  assert(plan && Array.isArray(review.findings) && review.findings.length > 0,
    'PLAN_REVIEW_FEEDBACK_INCOMPLETE', 'A rejected plan review requires the current plan and actionable findings.');
  const planner = state.features.find(item => item.metadata?.stage === 'version-planning' && !item.metadata.planReviewRound);
  const reviewer = state.features.find(item => item.metadata?.stage === 'plan-review' && !item.metadata.planReviewRound);
  assert(planner?.task && reviewer?.task, 'PLAN_REVIEW_ROOT_FEATURE_MISSING', 'Plan review continuation requires the original planner and reviewer Features.');
  const next = round + 1;
  const plannerId = `${planner.id}--review-revision-${next}`;
  const reviewerId = `${reviewer.id}--review-revision-${next}`;
  assert(!state.features.some(item => item.id === plannerId || item.id === reviewerId),
    'PLAN_REVIEW_ROUND_DUPLICATE', `Plan review round ${next} already exists.`);
  const feedback = { priorPlan: plan, findings: review.findings, priorReviewFeatureId: feature.id };
  const plannerTask = withTaskFeedback(planner.task, {
    id: 'review-feedback', path: 'planReviewFeedback',
    description: 'The complete preceding plan and exact independent review findings for this revision.',
    instruction: 'Resolve every independent review finding in a complete replacement plan. Preserve all prior acceptance coverage and project boundaries, and cite the finding or source evidence for each change.',
  });
  const reviewerTask = withTaskFeedback(reviewer.task, {
    id: 'previous-review', path: 'planReviewFeedback',
    description: 'The preceding independent review findings that the revised plan must address.',
    instruction: 'Check every preceding review finding against the revised complete plan, then independently inspect the full scope for remaining blockers. Report each fixed Finding ID in outputs["plan-review"].value.resolvedFindings and add a checkpoint with that exact ID, status resolved, a specific summary and non-empty evidence. Keep unresolved original IDs in the typed plan-review findings; add every newly discovered blocker to the top-level findings array with its ID, severity, summary, affectedPaths and evidence. Do not reopen an existing Authority Finding by duplicating it as a new top-level Finding. An approved result alone never closes a Finding.',
  });
  return [{
    ...structuredClone(planner), ...plannerTask,
    id: plannerId, logicalRoot: `${planner.logicalRoot}:review-revision:${next}`,
    dependsOn: [feature.id], state: 'pending',
    metadata: { ...structuredClone(planner.metadata), planReviewRound: next, planReviewFeedback: feedback },
  }, {
    ...structuredClone(reviewer), ...reviewerTask,
    id: reviewerId, logicalRoot: `${reviewer.logicalRoot}:review-revision:${next}`,
    dependsOn: [plannerId], state: 'pending',
    metadata: { ...structuredClone(reviewer.metadata), planReviewRound: next, planReviewFeedback: feedback },
  }];
};
