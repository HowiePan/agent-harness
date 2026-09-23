import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ProjectGateRunner } from '../src/index.mjs';
import { makeFixture, startRun, feature } from './test-support.mjs';
import { RunCoordinator } from '../src/platform/workflow/coordinator/run-coordinator.mjs';
import { digestJson } from '../src/common/canonical.mjs';
import { envelope } from '../src/platform/plugins/contracts.mjs';

test('Project Gate Runner executes Descriptor recipes, records Evidence, and reuses only success', async t => {
  const fixture = await makeFixture({ gateRecipes: [{ id: 'probe-final', executionClass: 'deterministic-process', scope: 'final', command: [process.execPath, resolve('test/fixtures/gate-probe.mjs')] }] });
  t.after(() => fixture.cleanup());
  const started = await startRun(fixture);
  assert.deepEqual(started.profile.config.requiredFinalGates, ['probe-final']);
  const progress = [];
  const runner = new ProjectGateRunner({ harness: fixture.harness, onProgress: event => progress.push(event) });
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
  assert(progress.some(event => event.phase === 'process-started'));
});

test('cached Gate success gets current Run Evidence and raw Gate submissions are denied', async t => {
  const fixture = await makeFixture({ gateRecipes: [{ id: 'cache-final', executionClass: 'deterministic-process', scope: 'final', command: [process.execPath, resolve('test/fixtures/gate-probe.mjs')] }] });
  t.after(() => fixture.cleanup());
  const runner = new ProjectGateRunner({ harness: fixture.harness, onProgress: () => {} });
  await startRun(fixture, { runId: 'first' });
  const first = await runner.run({ projectId: fixture.projectId, runId: 'first' });
  await startRun(fixture, { runId: 'second' });
  const second = await runner.run({ projectId: fixture.projectId, runId: 'second' });
  assert.equal(second.results[0].cacheHit, true);
  assert.notEqual(second.results[0].evidenceRefs[0], first.results[0].evidenceRefs[0]);
  const current = await fixture.harness.evidenceStore.read(second.results[0].evidenceRefs[0]);
  assert.equal(current.metadata.runId, 'second');
  const state = await fixture.harness.authorityStore.read(fixture.projectId, 'second');
  await assert.rejects(() => fixture.harness.kernel.recordGate(fixture.projectId, 'second', { id: 'cache-final', scope: 'final', specDigest: state.gates[0].specDigest, sourceDigest: state.sourceDigest, toolchainDigest: state.gates[0].toolchainDigest, status: 'passed', evidenceRefs: [first.results[0].evidenceRefs[0]] }, { expectedRevision: state.revision, commandId: 'forged-gate' }), error => error.code === 'DIRECT_GATE_RESULT_DENIED');
  await assert.rejects(() => fixture.harness.recordVerifiedGate(fixture.projectId, 'second', { id: 'cache-final', scope: 'final', specDigest: state.gates[0].specDigest, sourceDigest: state.sourceDigest, toolchainDigest: state.gates[0].toolchainDigest, status: 'passed', evidenceRefs: [first.results[0].evidenceRefs[0]], forcedFresh: true }, { expectedRevision: state.revision, commandId: 'replayed-gate' }), error => error.code === 'GATE_SUBMISSION_UNTRUSTED');
  await assert.rejects(() => runner.run({ projectId: fixture.projectId, runId: 'second', gateIds: ['cache-final', 'absent'] }), error => error.code === 'GATE_RECIPE_NOT_FOUND');
});

test('Gate cache misses when an external check script changes', async t => {
  const script = resolve('test/fixtures/gate-probe.mjs');
  const fixture = await makeFixture({ gateRecipes: [{ id: 'script-check', executionClass: 'deterministic-process', scope: 'final', command: [process.execPath, script] }] });
  t.after(() => fixture.cleanup());
  const externalScript = resolve(fixture.root, 'gate-script.mjs');
  await writeFile(externalScript, 'process.exit(0);\n', 'utf8');
  const project = await fixture.harness.projectRegistry.get(fixture.projectId);
  const revised = { id: project.id, workspace: project.workspace, profiles: project.profiles, policy: project.policy, gateRecipes: [{ id: 'script-check', executionClass: 'deterministic-process', scope: 'final', command: [process.execPath, externalScript] }], artifactProviders: project.artifactProviders };
  const { projectExecutionPolicyDecisionContext } = await import('../src/platform/registry/project-registry.mjs');
  await fixture.harness.projectRegistry.register(revised, { expectedRevision: project.revision, commandId: 'external-script-gate', authorityDecision: { actor: 'test-user', decision: 'approved', action: 'project-execution-policy-change', expiresAt: '2099-09-15T00:00:00.000Z', context: projectExecutionPolicyDecisionContext({ input: revised, expectedRevision: project.revision }) } });
  await startRun(fixture);
  const runner = new ProjectGateRunner({ harness: fixture.harness, onProgress: () => {} });
  const first = await runner.run({ projectId: fixture.projectId, runId: 'run' });
  assert.equal(first.results[0].cacheHit, false);
  await writeFile(externalScript, 'process.exit(0); // changed\n', 'utf8');
  const second = await runner.run({ projectId: fixture.projectId, runId: 'run' });
  assert.equal(second.results[0].cacheHit, false);
});

test('output budget failure is recorded as a Gate result', async t => {
  const fixture = await makeFixture({ gateRecipes: [{ id: 'limited', executionClass: 'deterministic-process', scope: 'final', command: [process.execPath, resolve('test/fixtures/gate-output-probe.mjs'), '1024', '250'], outputs: [{ id: 'gate-build', retention: 'ephemeral', environment: ['GATE_OUTPUT'], maxBytes: 16, maxFiles: 10 }] }] });
  t.after(() => fixture.cleanup());
  await startRun(fixture);
  const runner = new ProjectGateRunner({ harness: fixture.harness, onProgress: () => {} });
  const result = await runner.run({ projectId: fixture.projectId, runId: 'run' });
  assert.equal(result.results[0].status, 'budget-exceeded');
  assert.equal(result.state.gates[0].status, 'budget-exceeded');
});

test('Feature Gate blocks downstream dispatch until its own result passes', async t => {
  const fixture = await makeFixture({ gateRecipes: [{ id: 'feature-check', executionClass: 'deterministic-process', scope: 'feature', command: [process.execPath, resolve('test/fixtures/gate-probe.mjs')] }] });
  t.after(() => fixture.cleanup());
  await startRun(fixture, { features: [feature('first', {}, { gatePlan: ['feature-check'] }), feature('second', {}, { dependsOn: ['first'] })] });
  const coordinator = new RunCoordinator({ harness: fixture.harness, onGateProgress: () => {} });
  const result = await coordinator.run({ projectId: fixture.projectId, runId: 'run' });
  assert.equal(result.state.features.every(item => item.state === 'completed'), true);
  assert.equal(result.state.gates.find(gate => gate.id === 'feature-check')?.featureId, 'first');
  const events = result.state.events.map(event => event.type);
  assert(events.indexOf('gate.recorded') < events.lastIndexOf('dispatch.requested'));
});

test('Project Gate Runner invokes a bound Gate Executor plugin', async t => {
  const manifest = { id: 'fixture-gate-executor', kind: 'gate-executor', version: '1.0.0', capabilities: [], permissions: [] };
  const fixture = await makeFixture({ gateRecipes: [{ id: 'custom-final', executionClass: 'deterministic-process', scope: 'final', executorPluginId: manifest.id, command: ['custom-check'] }] });
  t.after(() => fixture.cleanup());
  fixture.harness.registerPlugin(manifest, { execute: async spec => envelope(manifest, 'receipt', { operation: 'gate', gateId: spec.id, status: 'passed', specDigest: digestJson(spec) }) });
  await startRun(fixture);
  const runner = new ProjectGateRunner({ harness: fixture.harness, onProgress: () => {} });
  await assert.rejects(() => fixture.harness.invokeGateExecutor(manifest.id, { id: 'custom-final' }), error => error.code === 'GATE_INVOCATION_UNTRUSTED');
  assert.equal((await runner.preflight({ projectId: fixture.projectId })).ready, true);
  const result = await runner.run({ projectId: fixture.projectId, runId: 'run' });
  assert.equal(result.results[0].status, 'passed');
  assert.equal(result.results[0].executorReceipt.pluginId, manifest.id);
});

test('failed Feature Gate blocks its dependent Feature', async t => {
  const fixture = await makeFixture({ gateRecipes: [{ id: 'feature-fail', executionClass: 'deterministic-process', scope: 'feature', command: [process.execPath, resolve('test/fixtures/gate-probe.mjs'), '--fail'] }] });
  t.after(() => fixture.cleanup());
  await startRun(fixture, { features: [feature('first', {}, { gatePlan: ['feature-fail'] }), feature('second', {}, { dependsOn: ['first'] }), feature('independent')] });
  const result = await new RunCoordinator({ harness: fixture.harness, onGateProgress: () => {} }).run({ projectId: fixture.projectId, runId: 'run' });
  assert.equal(result.reason, 'feature-gates-not-passed');
  assert.equal(result.state.features.find(item => item.id === 'second').state, 'pending');
  assert.equal(result.state.features.find(item => item.id === 'independent').state, 'completed');
  assert.equal(result.state.gates[0].status, 'failed');
});

test('required Stable Gate is a Kernel closure condition', async t => {
  const fixture = await makeFixture({ gateRecipes: [{ id: 'stable-check', executionClass: 'deterministic-process', scope: 'stable', command: [process.execPath, resolve('test/fixtures/gate-probe.mjs')] }] });
  t.after(() => fixture.cleanup());
  await startRun(fixture);
  const execution = await new RunCoordinator({ harness: fixture.harness }).run({ projectId: fixture.projectId, runId: 'run' });
  assert.equal(execution.state.features[0].state, 'completed');
  await assert.rejects(() => fixture.harness.kernel.closeRun(fixture.projectId, 'run', {}, { expectedRevision: execution.state.revision, commandId: 'close-before-stable' }), error => error.code === 'STABLE_GATE_REQUIRED');
  const runner = new ProjectGateRunner({ harness: fixture.harness, onProgress: () => {} });
  const checked = await runner.run({ projectId: fixture.projectId, runId: 'run', scope: 'stable', forceFresh: true });
  const closed = await fixture.harness.kernel.closeRun(fixture.projectId, 'run', {}, { expectedRevision: checked.state.revision, commandId: 'close-after-stable' });
  assert.equal(closed.state.status, 'closed');
});
