import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digestJson } from '../src/canonical.mjs';
import { RunLineageStore, resolveRunLineage, verifyRunLineageResolution } from '../src/lineage.mjs';
import { harnessTemporaryRoot } from '../src/write-boundary.mjs';

const now = '2026-09-15T12:00:00.000Z';
const plan = {
  project: { id: 'project' },
  logicalTaskKey: 'a'.repeat(64),
  planDigest: 'b'.repeat(64),
  intent: { profileId: 'feature-delivery', action: 'quality', target: 'v1', preset: 'full' },
  run: { runId: 'planned', profileId: 'feature-delivery', sourceDigest: 'c'.repeat(64), agentExecutionMode: 'conversation-visible' },
};

const state = ({ runId = 'planned', planDigest = plan.planDigest, status = 'ready', leases = [], dispatches = [], revision = 1, updatedAt = now } = {}) => {
  const body = {
    projectId: 'project', runId, revision, status, sourceDigest: plan.run.sourceDigest, updatedAt,
    profile: { id: 'feature-delivery' }, leases, dispatches,
    metadata: { logicalTaskKey: plan.logicalTaskKey, lifecyclePlanDigest: planDigest, commandIntent: plan.intent },
  };
  return { ...body, authorityDigest: digestJson(body) };
};

test('lineage resolver selects every safe lifecycle continuation without user choice', () => {
  assert.equal(resolveRunLineage({ plan, states: [], now: () => now }).action, 'start');
  assert.equal(resolveRunLineage({ plan, states: [state()], now: () => now }).action, 'continue');
  assert.equal(resolveRunLineage({ plan, states: [state({ status: 'closed' })], now: () => now }).action, 'return-closed');
  const healthyLease = { leaseId: 'lease', featureId: 'feature', status: 'active', lastHeartbeatAt: '2026-09-15T11:59:30.000Z', heartbeatTimeoutMs: 120000 };
  assert.equal(resolveRunLineage({ plan, states: [state({ status: 'running', leases: [healthyLease] })], now: () => now }).action, 'reattach');
  assert.equal(resolveRunLineage({ plan: { ...plan, run: { ...plan.run, agentExecutionMode: 'headless' } }, states: [state({ status: 'running', leases: [healthyLease] })], now: () => now }).action, 'ordinary-resume');
  const expiredLease = { ...healthyLease, lastHeartbeatAt: '2026-09-15T11:55:00.000Z' };
  assert.equal(resolveRunLineage({ plan, states: [state({ status: 'running', leases: [expiredLease] })], now: () => now }).action, 'ordinary-resume');
  const incompatible = state({ runId: 'old', planDigest: 'd'.repeat(64) });
  assert.equal(resolveRunLineage({ plan, states: [incompatible], now: () => now }).action, 'supersede-and-start');
  const incompatibleLive = state({ runId: 'old-live', planDigest: 'd'.repeat(64), status: 'running', leases: [healthyLease] });
  const blocked = resolveRunLineage({ plan, states: [incompatibleLive], now: () => now });
  assert.equal(blocked.action, 'block');
  assert.equal(blocked.reasonCode, 'INCOMPATIBLE_LIVE_LEASE');
});

test('lineage resolution is short-lived and invalidated by any candidate-set or Authority change', () => {
  const original = state();
  const resolution = resolveRunLineage({ plan, states: [original], now: () => now });
  assert.equal(verifyRunLineageResolution(resolution, { plan, states: [original], now: () => now }).action, 'continue');
  assert.throws(() => verifyRunLineageResolution(resolution, { plan, states: [{ ...original, revision: 2 }], now: () => now }), error => error.code === 'RUN_LINEAGE_RESOLUTION_STALE');
  assert.throws(() => verifyRunLineageResolution(resolution, { plan, states: [original, state({ runId: 'new-candidate', planDigest: 'd'.repeat(64) })], now: () => now }), error => error.code === 'RUN_LINEAGE_RESOLUTION_STALE');
  assert.throws(() => verifyRunLineageResolution(resolution, { plan, states: [original], now: () => '2026-09-15T12:02:00.000Z' }), error => error.code === 'RUN_LINEAGE_RESOLUTION_EXPIRED');
  const alternate = state({ runId: 'alternate', planDigest: 'd'.repeat(64) });
  const forward = resolveRunLineage({ plan, states: [original, alternate], now: () => now });
  const reversed = resolveRunLineage({ plan, states: [alternate, original], now: () => now });
  assert.equal(forward.resolutionDigest, reversed.resolutionDigest);
});

test('lineage Authority has one active Run and idempotent expected-revision updates', async t => {
  const parent = resolve(harnessTemporaryRoot(), 'lineage-tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'case-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RunLineageStore({ root, controlRoot: process.cwd(), now: () => now });
  const input = { projectId: 'project', logicalTaskKey: plan.logicalTaskKey, activeRunId: 'run-1', planDigest: plan.planDigest, resolutionDigest: 'e'.repeat(64) };
  const first = await store.activate(input, { expectedRevision: 0, commandId: 'activate-1' });
  const repeated = await store.activate(input, { expectedRevision: 0, commandId: 'activate-1' });
  assert.equal(repeated.reused, true);
  assert.equal(repeated.lineage.authorityDigest, first.lineage.authorityDigest);
  await assert.rejects(() => store.assertActive('project', plan.logicalTaskKey, 'run-2'), error => error.code === 'RUN_LINEAGE_NOT_ACTIVE');
  const second = await store.activate({ ...input, activeRunId: 'run-2', resolutionDigest: 'f'.repeat(64) }, { expectedRevision: 1, commandId: 'activate-2' });
  assert.equal(second.lineage.activeRunId, 'run-2');
  assert.equal(second.lineage.history[0].runId, 'run-1');
});
