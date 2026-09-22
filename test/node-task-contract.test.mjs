import assert from 'node:assert/strict';
import test from 'node:test';
import { defineNodeTaskContract, taskFeatureProjection } from '../src/common/task-contract.mjs';

const task = () => ({
  role: { id: 'contract-worker', description: 'Executes one contract-bound node.' },
  objective: 'Produce one verified result.',
  instructions: ['Use only resolved inputs.'],
  inputs: [{ id: 'target', source: 'intent', path: 'target', required: true, description: 'The exact command target.' }],
  steps: [{ id: 'inspect', instruction: 'Inspect the resolved target.' }, { id: 'produce', instruction: 'Produce the declared output.' }],
  constraints: ['Do not broaden authority.'],
  acceptance: ['The declared output is complete and valid.'],
  evidenceRequirements: ['Return evidence for the observed target.'],
});

test('Node Task Contract is deterministic, digest-bound, and projects complete Feature semantics', () => {
  const first = defineNodeTaskContract(task());
  const second = defineNodeTaskContract({ ...task(), taskDigest: first.taskDigest, schemaVersion: first.schemaVersion });
  assert.deepEqual(second, first);
  assert.match(first.taskDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(taskFeatureProjection(first), {
    task: first,
    ownerRole: 'contract-worker',
    acceptance: ['The declared output is complete and valid.'],
    steps: [{ id: 'inspect', title: 'Inspect the resolved target.' }, { id: 'produce', title: 'Produce the declared output.' }],
  });
});

test('Node Task Contract fails closed on missing semantics, unknown fields, and digest drift', () => {
  assert.throws(() => defineNodeTaskContract(null), error => error.code === 'NODE_TASK_REQUIRED');
  assert.throws(() => defineNodeTaskContract({ ...task(), prompt: 'free text' }), error => error.code === 'NODE_TASK_FIELD_UNKNOWN');
  assert.throws(() => defineNodeTaskContract({ ...task(), taskDigest: '0'.repeat(64) }), error => error.code === 'NODE_TASK_DIGEST_MISMATCH');
  assert.throws(() => defineNodeTaskContract({ ...task(), inputs: [...task().inputs, task().inputs[0]] }), error => error.code === 'NODE_TASK_INPUT_DUPLICATE');
});
