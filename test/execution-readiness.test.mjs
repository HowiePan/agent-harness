import assert from 'node:assert/strict';
import test from 'node:test';
import { sealExecutionReadinessReport, verifyExecutionReadinessReport } from '../src/execution-readiness.mjs';

const plan = {
  planDigest: 'a'.repeat(64),
  project: { id: 'project', revision: 2, descriptorDigest: 'b'.repeat(64) },
  harness: { version: '1.0.0', artifactDigest: 'c'.repeat(64) },
};

const report = executionReady => sealExecutionReadinessReport({
  protocolVersion: '1.0',
  kind: 'execution-readiness-report',
  planDigest: plan.planDigest,
  project: plan.project,
  release: { ...plan.harness, active: true, runtimeRoot: 'runtimes/1.0.0/candidate' },
  checks: [{ id: 'all', ready: executionReady, details: {}, issues: executionReady ? [] : [{ code: 'BLOCKED', message: 'blocked' }] }],
  writeProbe: { attempted: true, ready: executionReady, cleaned: true },
  executionReady,
  createdAt: '2026-09-15T00:00:00.000Z',
  expiresAt: '2026-09-15T00:01:00.000Z',
});

test('execution readiness is digest-bound, plan-bound, expiring, and required to be successful', () => {
  const ready = report(true);
  assert.equal(verifyExecutionReadinessReport(ready, { plan, now: () => '2026-09-15T00:00:30.000Z' }).executionReady, true);
  assert.throws(() => verifyExecutionReadinessReport({ ...ready, executionReady: false }, { plan, now: () => '2026-09-15T00:00:30.000Z' }), error => error.code === 'EXECUTION_READINESS_REPORT_DIGEST_MISMATCH');
  assert.throws(() => verifyExecutionReadinessReport(ready, { plan: { ...plan, planDigest: 'd'.repeat(64) }, now: () => '2026-09-15T00:00:30.000Z' }), error => error.code === 'EXECUTION_READINESS_PLAN_MISMATCH');
  assert.throws(() => verifyExecutionReadinessReport(ready, { plan, now: () => '2026-09-15T00:01:00.000Z' }), error => error.code === 'EXECUTION_READINESS_EXPIRED');
  assert.throws(() => verifyExecutionReadinessReport(report(false), { plan, now: () => '2026-09-15T00:00:30.000Z' }), error => error.code === 'EXECUTION_NOT_READY');
});
