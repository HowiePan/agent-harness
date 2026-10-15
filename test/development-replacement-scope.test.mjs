import assert from 'node:assert/strict';
import test from 'node:test';
import { assertDevelopmentReplacementScope } from '../src/application/development-replacement-scope.mjs';
import { expandApprovedImplementation } from '../src/flows/delivery-lifecycle/approved-implementation.mjs';
import { implementNode } from '../src/flows/delivery-lifecycle/nodes/implement/index.mjs';

const fixture = () => {
  const parent = { id: 'implement/V1', kind: 'implement', executionClass: 'agent-reasoning',
    logicalRoot: 'implement:V1', task: implementNode.task, acceptance: ['Implement approved scope.'],
    dependsOn: [], allowedPaths: ['src', 'docs'], forbiddenPaths: ['.git', 'other-project'],
    contracts: [], gatePlan: [], metadata: { stage: 'implementation', target: 'V1' } };
  const typedPlan = { proposedFeatures: [{ id: 'A00', projectId: 'project', disposition: 'project-owned',
    allowedPaths: ['AGENTS.md', '.agent/skills', 'src'], dependsOn: [], contracts: ['Guidance'], verification: ['Inspect'] }] };
  const project = { id: 'project', descriptorDigest: 'd'.repeat(64),
    policy: { actionPaths: { implement: ['AGENTS.md', '.agent/skills', 'src', 'docs'] } } };
  const plan = { project, logicalTaskKey: 'logical', stopCondition: { requiredFinalGates: ['tests'] },
    run: { sourceDigest: 'source', executionWorkspaceRoot: 'F:/project',
      features: [{ ...parent, allowedPaths: [...project.policy.actionPaths.implement] }] } };
  const retired = { projectId: 'project', status: 'superseded', sourceDigest: 'source',
    features: expandApprovedImplementation({ features: [parent], typedPlan, projectId: 'project' }),
    metadata: { supersededReason: `development-h2-recovery:${'a'.repeat(64)}`,
      logicalTaskKey: 'logical', stopCondition: plan.stopCondition, workspace: { root: 'F:/project' },
      approvedPlan: { projectId: 'project', runId: 'approved-plan', planDigest: 'a'.repeat(64),
        artifactDigest: 'b'.repeat(64), typedPlan } } };
  return { retired, plan, project };
};

test('retirement ledger refresh accepts only approved Descriptor guidance paths before any completion', () => {
  const input = fixture();
  const before = structuredClone(input);
  const features = assertDevelopmentReplacementScope(input);
  assert.deepEqual(features[0].allowedPaths, input.project.policy.actionPaths.implement);
  assert.deepEqual(input, before);
  input.project.policy.actionPaths.implement.reverse();
  input.plan.run.features[0].allowedPaths.reverse();
  assertDevelopmentReplacementScope(input);
});

test('replacement rejects unapproved paths, changed dependencies, forbidden boundaries and final gates', () => {
  const changes = [
    input => { input.project.policy.actionPaths.implement.push('other-project'); input.plan.run.features[0].allowedPaths.push('other-project'); },
    input => { input.plan.run.features[0].allowedPaths.push('extra'); },
    input => { input.plan.run.features.push({ ...input.plan.run.features[0], id: 'new', logicalRoot: 'new' }); },
    input => { input.retired.features[0].dependsOn.push('old-dependency'); },
    input => { input.plan.run.features[0].forbiddenPaths = []; },
    input => { input.plan.stopCondition = { requiredFinalGates: [] }; },
    input => { input.plan.run.sourceDigest = 'changed'; },
    input => { input.plan.run.executionWorkspaceRoot = 'F:/sibling'; },
    input => { input.plan.project = { ...input.plan.project, descriptorDigest: 'other' }; },
    input => { input.plan.logicalTaskKey = 'other'; },
    input => { input.retired.metadata.supersededReason = 'manual'; },
    input => { input.retired.metadata.approvedPlan.projectId = 'other-project'; },
  ];
  for (const change of changes) {
    const input = fixture();
    change(input);
    assert.throws(() => assertDevelopmentReplacementScope(input),
      error => error.code === 'VISIBLE_DEVELOPMENT_RECOVERY_PLAN_CHANGED');
  }
});

test('completed implementation cannot widen its scope through unstarted replacement validation', () => {
  const input = fixture();
  input.retired.features[0].state = 'completed';
  assert.throws(() => assertDevelopmentReplacementScope(input),
    error => error.code === 'VISIBLE_DEVELOPMENT_RECOVERY_PLAN_CHANGED');
  input.plan.run.features[0].allowedPaths = [...input.retired.features[0].allowedPaths];
  assertDevelopmentReplacementScope(input);
});

test('unchanged non-implementation recovery still checks its original scope', () => {
  const input = fixture();
  delete input.retired.metadata.approvedPlan;
  input.plan.run.features = [{ id: 'quality', allowedPaths: [], forbiddenPaths: ['.git'],
    dependsOn: [], metadata: { stage: 'quality' } }];
  input.retired.features = structuredClone(input.plan.run.features);
  assertDevelopmentReplacementScope(input);
  input.plan.run.features[0].allowedPaths = ['src'];
  assert.throws(() => assertDevelopmentReplacementScope(input),
    error => error.code === 'VISIBLE_DEVELOPMENT_RECOVERY_PLAN_CHANGED');
});
