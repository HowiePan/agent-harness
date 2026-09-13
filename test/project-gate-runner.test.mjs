import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { ProjectGateRunner } from '../src/index.mjs';
import { makeFixture, startRun } from './test-support.mjs';

test('Project Gate Runner executes Descriptor recipes, records Evidence, and reuses only success', async t => {
  const fixture = await makeFixture({ gateRecipes: [{ id: 'probe-final', scope: 'final', command: [process.execPath, resolve('test/fixtures/gate-probe.mjs')] }] });
  t.after(() => fixture.cleanup());
  const started = await startRun(fixture);
  assert.deepEqual(started.profile.config.requiredFinalGates, ['probe-final']);
  const runner = new ProjectGateRunner({ harness: fixture.harness });
  const first = await runner.run({ projectId: fixture.projectId, runId: 'run', scope: 'final' });
  assert.equal(first.results[0].status, 'passed');
  assert.equal(first.results[0].executorReceipt.payload.outputReceipt.status, 'cleaned');
  assert.equal(first.results[0].cacheHit, false);
  assert.equal(first.state.gates[0].evidenceRefs.length, 1);
  const second = await runner.run({ projectId: fixture.projectId, runId: 'run', scope: 'final' });
  assert.equal(second.results[0].status, 'passed');
  assert.equal(second.results[0].cacheHit, true);
  const fresh = await runner.run({ projectId: fixture.projectId, runId: 'run', scope: 'final', forceFresh: true });
  assert.equal(fresh.results[0].cacheHit, false);
  assert.equal(fresh.state.gates[0].forcedFresh, true);
});
