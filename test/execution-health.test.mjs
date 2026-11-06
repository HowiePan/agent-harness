import assert from 'node:assert/strict';
import test from 'node:test';
import { executionHealth } from '../src/common/execution-health.mjs';
import { resolveResourceLimits } from '../src/platform/plugins/execution/resource-guard.mjs';
test('hour-long execution with current verified checkpoints continues; elapsed time alone only requests diagnosis', () => {
  const base = { startedAt: 0, observedAt: 7200000 };
  assert.equal(executionHealth({ ...base, progress: [{ kind: 'checkpoint', at: 7199999, hostVerified: true, evidenceRef: 'proof:current' }] }).action, 'observe');
  assert.equal(executionHealth(base).action, 'diagnose');
  assert.equal(executionHealth({ ...base, progress: [{ kind: 'stdout', at: 7200000, hostVerified: true, evidenceRef: 'logs' }] }).action, 'diagnose');
  assert.equal(executionHealth({ ...base, progress: [{ kind: 'checkpoint', at: 7200000, hostVerified: false, evidenceRef: 'claim' }] }).action, 'diagnose');
});
test('explicit failure, stop, resource limit and stale observation receive distinct dispositions', () => {
  const base = { startedAt: 0, observedAt: 1 };
  assert.equal(executionHealth({ ...base, state: 'failed' }).action, 'recover');
  assert.equal(executionHealth({ ...base, userStopped: true }).action, 'stop');
  assert.equal(executionHealth({ ...base, resourceViolation: 'memory' }).action, 'stop');
  assert.equal(executionHealth({ ...base, observationFresh: false }).action, 'diagnose');
});
test('resource protection has no default deadline and accepts explicit long deadlines without widening resource caps', () => {
  assert.equal(resolveResourceLimits().timeoutMs, 0);
  assert.equal(resolveResourceLimits({ timeoutMs: 7200000 }).timeoutMs, 7200000);
  assert.throws(() => resolveResourceLimits({ cpuPercent: 100 }), { code: 'RESOURCE_POLICY_INVALID' });
  assert.throws(() => resolveResourceLimits({ timeoutMs: -1 }), { code: 'RESOURCE_POLICY_INVALID' });
});
