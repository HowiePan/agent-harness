import assert from 'node:assert/strict';
import test from 'node:test';
import { assertLocalProcessGateHost } from '../integrations/codex/agent-harness-codex/lib/local-process-gate-readiness.mjs';

test('local source Gate readiness rejects a Host that cannot capture child process output', () => {
  const recipes = [{ id: 'final', executionClass: 'deterministic-process', command: ['node', 'check.mjs'] }];
  let observed;
  assert.throws(() => assertLocalProcessGateHost({ recipes, spawn: (executable, args, options) => {
    observed = { executable, args, options };
    return { error: Object.assign(new Error('spawn EPERM'), { code: 'EPERM' }), status: null };
  } }), error => error.code === 'LOCAL_PROCESS_GATE_HOST_UNAVAILABLE' && error.details.processCode === 'EPERM');
  assert.deepEqual(observed.args, ['-e', '']);
  assert.deepEqual(observed.options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.doesNotThrow(() => assertLocalProcessGateHost({ recipes, spawn: () => ({ status: 0 }) }));
  assert.doesNotThrow(() => assertLocalProcessGateHost({ recipes: [], spawn: () => { throw new Error('not needed'); } }));
});
