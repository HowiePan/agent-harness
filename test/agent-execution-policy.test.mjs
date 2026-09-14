import assert from 'node:assert/strict';
import test from 'node:test';
import { extensionPack as codexRuntimeExtension } from '../src/extensions/codex-runtime.mjs';
import { RunCoordinator } from '../src/coordinator/run-coordinator.mjs';
import { assertAgentRuntimeCompatible, assertRuntimeTransportReceipt } from '../src/plugins/runtime/execution-policy.mjs';
import { validatePluginManifest } from '../src/plugins/contracts.mjs';
import { command, feature, makeFixture, startRun } from './test-support.mjs';

const visibleManifest = {
  id: 'visible-runtime',
  kind: 'agent-runtime',
  version: '1.0.0',
  capabilities: ['spawn', 'wait', 'send', 'heartbeat', 'interrupt', 'user-visible', 'host-orchestrated', 'workspace-shared'],
  permissions: ['agent.conversation'],
};

test('process-backed Agent Runtimes must be explicitly headless and cannot claim user visibility', () => {
  const base = { id: 'process-agent', kind: 'agent-runtime', version: '1.0.0', capabilities: ['spawn', 'wait', 'send', 'heartbeat', 'interrupt', 'managed-outputs'], permissions: ['process.spawn'], execution: { outputs: [{ id: 'tmp', retention: 'ephemeral', maxBytes: 1, maxFiles: 1 }] } };
  assert.throws(() => validatePluginManifest(base), error => error.code === 'PROCESS_AGENT_RUNTIME_MUST_BE_HEADLESS');
  assert.throws(() => validatePluginManifest({ ...base, capabilities: [...base.capabilities, 'headless', 'user-visible'], permissions: ['process.spawn', 'agent.conversation'] }), error => error.code === 'PROCESS_AGENT_RUNTIME_CANNOT_BE_USER_VISIBLE');
  assert.throws(() => validatePluginManifest({ id: 'unorchestrated-visible', kind: 'agent-runtime', version: '1.0.0', capabilities: ['spawn', 'wait', 'send', 'heartbeat', 'interrupt', 'user-visible'], permissions: ['agent.conversation'] }), error => error.code === 'USER_VISIBLE_RUNTIME_MUST_BE_HOST_ORCHESTRATED');
});

test('conversation-visible projects reject headless Runtime selection and require inspectable receipts', () => {
  const project = { id: 'interactive', policy: { agentExecutionMode: 'conversation-visible' } };
  const headless = { ...visibleManifest, id: 'headless-runtime', capabilities: ['spawn', 'wait', 'send', 'heartbeat', 'interrupt', 'headless'], permissions: [] };
  assert.throws(() => assertAgentRuntimeCompatible({ project, manifest: headless }), error => error.code === 'USER_VISIBLE_AGENT_RUNTIME_REQUIRED');
  assert.throws(() => assertRuntimeTransportReceipt({ project, manifest: visibleManifest, receipt: { runtimePluginId: visibleManifest.id } }), error => error.code === 'USER_VISIBLE_RUNTIME_RECEIPT_REQUIRED');
  assert.deepEqual(assertRuntimeTransportReceipt({ project, manifest: visibleManifest, receipt: { runtimePluginId: visibleManifest.id, agentId: 'agent-1', dispatchId: 'dispatch-1', packetDigest: 'a'.repeat(64), visibility: { mode: 'user-visible', surface: 'codex-task', inspectRef: 'task-123' } } }).mode, 'conversation-visible');
});

test('host-orchestrated visible Runtime schedules work but never falls back to a CLI process', async t => {
  const runtime = 'codex-conversation-runtime';
  const agentAdapter = { verifyVisibleLease: async ({ agentId, dispatch }) => ({ verified: true, provider: 'test-host', assertionId: 'attestation-1', agentId, dispatchId: dispatch.dispatchId, packetDigest: dispatch.packetDigest }) };
  const fixture = await makeFixture({ extensions: [codexRuntimeExtension], agentAdapter, policy: { agentExecutionMode: 'conversation-visible', runtimePlugins: [runtime], defaultRuntimePlugin: runtime, maxConcurrency: 'auto' } });
  t.after(() => fixture.cleanup());
  await startRun(fixture, { features: [feature('visible-review')] });
  const coordinator = await new RunCoordinator({ harness: fixture.harness }).tick({ projectId: fixture.projectId, runId: 'run' });
  assert.equal(coordinator.status, 'attention-required');
  assert.equal(coordinator.reason, 'user-visible-runtime-requires-host-orchestration');
  let state = await fixture.harness.authorityStore.read(fixture.projectId, 'run');
  assert.equal(state.dispatches.length, 0);
  const scheduled = await fixture.harness.dispatch(fixture.projectId, 'run', { maxConcurrency: 1, runtimePluginId: runtime }, command(state));
  const dispatch = scheduled.result.dispatches[0];
  const read = await fixture.harness.readDispatchPacket(fixture.projectId, 'run', dispatch.dispatchId);
  assert.equal(read.packet.dispatchId, dispatch.dispatchId);
  state = scheduled.state;
  await assert.rejects(() => fixture.harness.kernel.bindLease(fixture.projectId, 'run', { dispatchId: dispatch.dispatchId, agentId: 'bypass-agent', packetDigest: dispatch.packetDigest, runtimeReceipt: { runtimePluginId: runtime } }, command(state)), error => error.code === 'DIRECT_LEASE_BIND_DENIED');
  await assert.rejects(() => fixture.harness.pluginHost.invoke(runtime, 'spawn', read.packet), error => error.code === 'DIRECT_EXECUTION_PLUGIN_INVOKE_DENIED');
  await assert.rejects(() => fixture.harness.bindDispatch(fixture.projectId, 'run', { dispatchId: dispatch.dispatchId, agentId: 'visible-agent', runtimeReceipt: { runtimePluginId: runtime } }, command(state)), error => error.code === 'USER_VISIBLE_RUNTIME_RECEIPT_REQUIRED');
  const bound = await fixture.harness.bindDispatch(fixture.projectId, 'run', { dispatchId: dispatch.dispatchId, agentId: 'visible-agent', runtimeReceipt: { runtimePluginId: runtime, agentId: 'visible-agent', dispatchId: dispatch.dispatchId, packetDigest: dispatch.packetDigest, visibility: { mode: 'user-visible', surface: 'codex-task', inspectRef: 'task-123' } } }, command(state));
  assert.equal(bound.result.lease.agentId, 'visible-agent');
  assert.equal(bound.result.lease.runtimeReceipt.hostAttestation.verified, true);
  await assert.rejects(() => fixture.harness.recordResult(fixture.projectId, 'run', dispatch.dispatchId, { status: 'completed', summary: 'done' }, { commandId: command().commandId }), error => error.code === 'VISIBLE_AGENT_HEARTBEAT_REQUIRED');
});
