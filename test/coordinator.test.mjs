import assert from 'node:assert/strict';
import test from 'node:test';
import { createInMemoryRuntime, createStaticModelRouter, RunCoordinator } from '../src/index.mjs';
import { feature, makeFixture, startRun } from './test-support.mjs';

test('Coordinator schedules, binds, waits, and commits Runtime results to Authority', async t => {
  const manifest = { id: 'coordinator-memory-runtime', kind: 'agent-runtime', version: '1.0.0', capabilities: ['spawn', 'wait', 'send', 'heartbeat', 'interrupt', 'workspace-isolated'], permissions: [] };
  const fixture = await makeFixture({ policy: { runtimePlugins: [manifest.id], defaultRuntimePlugin: manifest.id, maxConcurrency: 2 } });
  t.after(() => fixture.cleanup());
  fixture.harness.registerPlugin(manifest, createInMemoryRuntime({ manifest, handler: async packet => ({ status: 'completed', summary: `completed:${packet.feature.id}`, changedFiles: [] }) }));
  await startRun(fixture, { features: [feature('one'), feature('two')] });
  const coordinator = new RunCoordinator({ harness: fixture.harness });
  const result = await coordinator.run({ projectId: fixture.projectId, runId: 'run', maxConcurrency: 2 });
  assert.equal(result.status, 'idle');
  assert.equal(result.reason, 'ready-to-close');
  assert.equal(result.state.features.every(item => item.state === 'completed'), true);
  assert.equal(result.rounds[0].committed.length, 2);
});

test('Coordinator binds a replaceable Model Router decision into the immutable Dispatch packet', async t => {
  const runtimeManifest = { id: 'routed-memory-runtime', kind: 'agent-runtime', version: '1.0.0', capabilities: ['spawn', 'wait', 'send', 'heartbeat', 'interrupt', 'workspace-isolated'], permissions: [] };
  const routerManifest = { id: 'project-model-router', kind: 'model-router', version: '1.0.0', capabilities: ['capability-route'], permissions: [] };
  const fixture = await makeFixture({ policy: { runtimePlugins: [runtimeManifest.id], defaultRuntimePlugin: runtimeManifest.id, modelRouterPlugin: routerManifest.id } });
  t.after(() => fixture.cleanup());
  let observed;
  fixture.harness.registerPlugin(routerManifest, createStaticModelRouter({ manifest: routerManifest, routes: [{ roles: ['worker'], capabilities: ['rust'], provider: 'replaceable', model: 'model-a' }], fallback: { provider: 'replaceable', model: 'fallback' } }));
  fixture.harness.registerPlugin(runtimeManifest, createInMemoryRuntime({ manifest: runtimeManifest, handler: async packet => { observed = packet.execution.modelRoute; return { status: 'completed', summary: 'routed', changedFiles: [] }; } }));
  await startRun(fixture, { features: [feature('routed', { requiredCapabilities: ['rust'] })] });
  const result = await new RunCoordinator({ harness: fixture.harness }).run({ projectId: fixture.projectId, runId: 'run' });
  assert.equal(result.status, 'idle');
  assert.equal(observed.pluginId, routerManifest.id);
  assert.equal(observed.route.model, 'model-a');
  assert.equal(result.state.dispatches[0].execution.modelRoute.route.provider, 'replaceable');
});
