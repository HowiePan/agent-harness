import assert from 'node:assert/strict';
import test from 'node:test';
import { createDispatchResultContract, validateBusinessResult } from '../src/platform/execution/result-contract.mjs';

const feature = {
  metadata: {
    outputPorts: { answer: 'qa-answer-v1' },
    outputValueSchemas: {
      answer: {
        type: 'object', required: ['claim', 'evidence'],
        properties: { claim: { type: 'string', minLength: 1 }, evidence: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } } },
        additionalProperties: false,
      },
    },
  },
};

const result = value => ({ status: 'completed', summary: 'Answered from evidence.', changedFiles: [], outputs: { answer: { schemaId: 'qa-answer-v1', value, evidenceRefs: ['source:1'] } } });

test('typed result contract binds the declared value schema and validates the actual value', () => {
  const contract = createDispatchResultContract(feature, { conversationVisible: true });
  assert.equal(contract.outputPorts.answer, 'qa-answer-v1');
  assert.equal(contract.outputValueSchemas.answer.required.includes('evidence'), true);
  assert.deepEqual(validateBusinessResult(result({ claim: 'supported', evidence: ['source:1'] }), { conversationVisible: true, feature }).outputs.answer.value.evidence, ['source:1']);
  assert.throws(() => validateBusinessResult(result({ claim: 'unsupported', evidence: [] }), { conversationVisible: true, feature }), error => error.code === 'RESULT_OUTPUT_VALUE_SCHEMA_INVALID');
  assert.throws(() => validateBusinessResult({ ...result({ claim: 'supported', evidence: ['source:1'] }), outputs: {} }, { conversationVisible: true, feature }), error => error.code === 'RESULT_OUTPUT_PORTS_MISMATCH');
});

test('typed feature missing a value schema fails before Dispatch', () => {
  assert.throws(() => createDispatchResultContract({ metadata: { outputPorts: { answer: 'qa-answer-v1' } } }), error => error.code === 'RESULT_OUTPUT_VALUE_SCHEMA_REQUIRED');
});

test('a failed typed result is not required to fabricate successful output ports', () => {
  const failed = { status: 'failed', summary: 'Source unavailable.', changedFiles: [], failureClass: 'source', blocker: { kind: 'source', summary: 'Source unavailable.', code: 'SOURCE_UNAVAILABLE' } };
  assert.equal(validateBusinessResult(failed, { conversationVisible: true, feature }).status, 'failed');
});
