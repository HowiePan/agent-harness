import assert from 'node:assert/strict';
import test from 'node:test';
import { composableWorkflowProfile } from '../src/platform/workflow/profiles/composable-workflow.mjs';
import { taskContract } from './test-support.mjs';

const body = {
  id: 'review', executionClass: 'agent-reasoning', task: taskContract('review', ['Review the current result.']), acceptance: ['Review the current result.'], dependsOn: [], allowedPaths: [],
  metadata: { workflow: { nodeId: 'review' }, outputPorts: { review: 'review-v1' } },
};

test('repeat rules append bounded, acyclic Feature iterations until typed output matches', () => {
  const config = composableWorkflowProfile.validateConfig({ repeats: [{ id: 'refine', nodeId: 'review', portId: 'review', schemaId: 'review-v1', path: 'passed', until: true, maxIterations: 2, onExhausted: 'attention-required', features: [body] }] });
  const initial = { ...structuredClone(body), id: 'review-initial', state: 'completed' };
  const state = { profile: { config }, features: [initial], metadata: { memorySnapshot: [] } };
  const appended = composableWorkflowProfile.createFollowUpFeatures({ state, feature: initial, result: { status: 'completed', outputs: { review: { schemaId: 'review-v1', value: { passed: false } } } } });
  assert.equal(appended[0].id, 'review--repeat-refine-2');
  assert.deepEqual(appended[0].dependsOn, ['review-initial']);
  assert.deepEqual(composableWorkflowProfile.createFollowUpFeatures({ state: { ...state, features: [...state.features, ...appended] }, feature: appended[0], result: { status: 'completed', outputs: { review: { schemaId: 'review-v1', value: { passed: true } } } } }), []);
  assert.throws(() => composableWorkflowProfile.createFollowUpFeatures({ state: { ...state, features: [...state.features, ...appended] }, feature: appended[0], result: { status: 'completed', outputs: { review: { schemaId: 'review-v1', value: { passed: false } } } } }), error => error.code === 'WORKFLOW_REPEAT_EXHAUSTED');
});

test('repeat rules reject unbounded and cyclic bodies', () => {
  assert.throws(() => composableWorkflowProfile.validateConfig({ repeats: [{ id: 'bad', nodeId: 'review', portId: 'review', schemaId: 'review-v1', path: 'passed', until: true, maxIterations: 0, onExhausted: 'attention-required', features: [body] }] }), error => error.code === 'WORKFLOW_REPEAT_INVALID');
  const cyclic = [{ ...body, id: 'a', dependsOn: ['b'] }, { ...body, id: 'b', dependsOn: ['a'] }];
  assert.throws(() => composableWorkflowProfile.validateConfig({ repeats: [{ id: 'cycle', nodeId: 'review', portId: 'review', schemaId: 'review-v1', path: 'passed', until: true, maxIterations: 2, onExhausted: 'attention-required', features: cyclic }] }), error => ['FEATURE_GRAPH_CYCLE', 'FEATURE_DEPENDENCY_UNKNOWN'].includes(error.code));
});
