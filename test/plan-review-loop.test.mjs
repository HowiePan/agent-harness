import test from 'node:test';
import assert from 'node:assert/strict';
import { defineNodeTaskContract } from '../src/common/task-contract.mjs';
import { validateWorkGraph } from '../src/kernel/work-graph.mjs';
import { createDeliveryLifecycleProfile } from '../src/flows/delivery-lifecycle/policy/delivery-lifecycle.mjs';
import { planApprovalSnapshot } from '../src/flows/delivery-lifecycle/plan-approval.mjs';

const task = (role, inputs = []) => defineNodeTaskContract({
  role: { id: role, description: role }, objective: 'Produce a complete plan or independent review.',
  instructions: ['Inspect the full scope.'], inputs,
  steps: [{ id: 'inspect', instruction: 'Inspect the current source.' }],
  constraints: ['Remain within the assigned scope.'], acceptance: ['Return the declared typed output.'],
  evidenceRequirements: ['Cite exact evidence.'],
});

const feature = (id, stage, taskValue, nodeId, dependsOn = []) => ({
  id, executionClass: 'agent-reasoning', kind: 'delivery-stage', ownerRole: taskValue.role.id,
  logicalRoot: id, laneId: 'plan', task: taskValue, acceptance: taskValue.acceptance,
  steps: [{ id: 'inspect', title: 'Inspect the current source.' }], dependsOn,
  allowedPaths: stage === 'version-planning' ? ['docs/versions'] : [], forbiddenPaths: ['.git'],
  metadata: { stage, sourcePolicy: stage === 'version-planning' ? 'write' : 'read-only', workflow: { nodeId },
    outputPorts: { [nodeId]: stage === 'version-planning' ? 'delivery-plan-v1' : 'delivery-plan-review-v1' } },
  state: 'completed',
});

const seed = () => {
  const planner = feature('plan/V1', 'version-planning', task('delivery-planner'), 'plan');
  const reviewer = feature('plan-review/V1', 'plan-review', task('plan-scope-reviewer', [{ id: 'upstream.plan.plan', source: 'upstream', nodeId: 'plan', portId: 'plan', schemaId: 'delivery-plan-v1', required: true, description: 'The proposed plan.' }]), 'plan-review', [planner.id]);
  const original = { features: ['F-02'], proposedFeatures: [{ id: 'F-02', allowedPaths: ['src/world.rs'], dependsOn: [] }], acceptanceCoverage: { 1: ['F-02'] } };
  const state = { projectId: 'engine', runId: 'run-1', sourceDigest: 'a'.repeat(64),
    metadata: { commandIntent: { target: 'V1' } }, profile: { config: { planReviewLimit: 3 } },
    features: [planner, reviewer], submissions: [
      { featureId: planner.id, result: { status: 'completed', outputs: { plan: { value: original } } } },
      { featureId: reviewer.id, result: { status: 'completed', outputs: { 'plan-review': { value: { approved: false, findings: ['F-02 lacks its transform entry point.'] } } } } },
    ] };
  return { state, reviewer, original };
};

test('rejected review appends a bounded in-run planning and independent review pair', () => {
  const { state, reviewer, original } = seed();
  const profile = createDeliveryLifecycleProfile();
  const result = state.submissions.at(-1).result;
  const followUps = profile.createFollowUpFeatures({ state, feature: reviewer, result, findings: [] });
  assert.equal(followUps.length, 2);
  assert.deepEqual(followUps.map(item => item.dependsOn), [[reviewer.id], [followUps[0].id]]);
  assert.deepEqual(followUps[0].metadata.planReviewFeedback.priorPlan, original);
  assert.deepEqual(followUps[0].metadata.planReviewFeedback.findings, ['F-02 lacks its transform entry point.']);
  assert.equal(followUps[0].task.inputs.at(-1).id, 'review-feedback');
  assert.equal(followUps[1].task.inputs.at(-1).id, 'previous-review');
  validateWorkGraph([...state.features, ...followUps]);
  assert.deepEqual(profile.canDispatch(followUps[0], { ...state, features: [...state.features, ...followUps] }), { ok: true });
  const revised = { ...original, proposedFeatures: [{ ...original.proposedFeatures[0], allowedPaths: ['src/world.rs', 'src/lexicon/special.rs'] }] };
  state.features.push(...followUps.map(item => ({ ...item, state: 'completed' })));
  state.submissions.push({ featureId: followUps[0].id, result: { status: 'completed', outputs: { plan: { value: revised } } } });
  state.submissions.push({ featureId: followUps[1].id, result: { status: 'completed', outputs: { 'plan-review': { value: { approved: true, findings: [] } } } } });
  const snapshot = planApprovalSnapshot(state);
  assert.equal(snapshot.reviewApproved, true);
  assert.match(snapshot.markdown, /src\/lexicon\/special\.rs/);
  assert.deepEqual(profile.createFollowUpFeatures({ state, feature: followUps[1], result: state.submissions.at(-1).result, findings: [] }), []);
});

test('plan review exhaustion stops the loop without approving the plan', () => {
  const { state, reviewer } = seed();
  state.profile.config.planReviewLimit = 1;
  const profile = createDeliveryLifecycleProfile();
  assert.deepEqual(profile.createFollowUpFeatures({ state, feature: reviewer, result: state.submissions.at(-1).result, findings: [] }), []);
  assert.equal(planApprovalSnapshot(state).reviewApproved, false);
  assert.deepEqual(profile.canClose(state), { ok: false, reason: 'plan-scope-review-not-approved' });
});
