import assert from 'node:assert/strict';
import test from 'node:test';
import { extensionPack as codexRuntimeExtension } from '../integrations/codex/extensions/codex-runtime.mjs';
import { RunCoordinator } from '../src/platform/workflow/coordinator/run-coordinator.mjs';
import { assertAgentRuntimeCompatible, assertRuntimeTransportReceipt, resolveLifecycleExecutionPolicy } from '../src/platform/plugins/runtime/execution-policy.mjs';
import { createVisibleHostAdapter } from '../src/platform/plugins/runtime/visible-host-adapter.mjs';
import { validatePluginManifest } from '../src/platform/plugins/contracts.mjs';
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
  const prompt = { codecPluginId: 'reference-agent-prompt-codec', codecPluginVersion: '1.0.0', contractVersion: '1.0', packetDigest: 'a'.repeat(64), promptDigest: 'b'.repeat(64) };
  const headless = { ...visibleManifest, id: 'headless-runtime', capabilities: ['spawn', 'wait', 'send', 'heartbeat', 'interrupt', 'headless'], permissions: [] };
  assert.throws(() => assertAgentRuntimeCompatible({ project, manifest: headless }), error => error.code === 'USER_VISIBLE_AGENT_RUNTIME_REQUIRED');
  assert.throws(() => assertRuntimeTransportReceipt({ project, manifest: visibleManifest, receipt: { runtimePluginId: visibleManifest.id } }), error => error.code === 'USER_VISIBLE_RUNTIME_RECEIPT_REQUIRED');
  assert.throws(() => assertRuntimeTransportReceipt({ project, manifest: visibleManifest, receipt: { runtimePluginId: visibleManifest.id, agentId: 'agent-1', dispatchId: 'dispatch-1', packetDigest: 'a'.repeat(64), visibility: { mode: 'user-visible', surface: 'codex-task', inspectRef: 'task-123' } } }), error => error.code === 'USER_VISIBLE_RUNTIME_PROMPT_RECEIPT_REQUIRED');
  assert.deepEqual(assertRuntimeTransportReceipt({ project, manifest: visibleManifest, receipt: { runtimePluginId: visibleManifest.id, agentId: 'agent-1', dispatchId: 'dispatch-1', packetDigest: 'a'.repeat(64), prompt, visibility: { mode: 'user-visible', surface: 'codex-task', inspectRef: 'task-123' } } }).mode, 'conversation-visible');
  assert.throws(() => assertRuntimeTransportReceipt({ project, manifest: visibleManifest, receipt: { runtimePluginId: visibleManifest.id, agentId: 'agent-1', dispatchId: 'dispatch-1', packetDigest: 'a'.repeat(64), prompt: { ...prompt, packetDigest: 'c'.repeat(64) }, visibility: { mode: 'user-visible', surface: 'codex-task', inspectRef: 'task-123' } } }), error => error.code === 'USER_VISIBLE_RUNTIME_PROMPT_PACKET_MISMATCH');
});

test('action-scoped execution is configuration only and legacy persisted authorization is rejected', () => {
  const project = { id: 'engine', policy: { agentExecutionMode: 'conversation-visible', defaultRuntimePlugin: 'visible-runtime', runtimePlugins: ['visible-runtime', 'headless-runtime'], actionExecution: { quality: { agentExecutionMode: 'headless', runtimePluginId: 'headless-runtime' } } } };
  assert.deepEqual(resolveLifecycleExecutionPolicy({ project, action: 'plan' }).mode, 'conversation-visible');
  assert.deepEqual(resolveLifecycleExecutionPolicy({ project, action: 'quality' }), { action: 'quality', mode: 'headless', runtimePluginId: 'headless-runtime', scoped: true });
  const headless = { ...visibleManifest, id: 'headless-runtime', capabilities: ['spawn', 'wait', 'send', 'heartbeat', 'interrupt', 'headless'], permissions: [] };
  assert.equal(assertAgentRuntimeCompatible({ project, manifest: headless, action: 'quality', runtimePluginId: 'headless-runtime', agentExecutionMode: 'headless' }).mode, 'headless');
  assert.throws(() => assertAgentRuntimeCompatible({ project, manifest: headless, action: 'plan', runtimePluginId: 'headless-runtime' }), error => error.code === 'LIFECYCLE_RUNTIME_POLICY_MISMATCH');
  const legacy = structuredClone(project);
  legacy.policy.actionExecution.quality.authorization = { actor: 'self-asserted', decision: 'approved', action: 'quality', authorizedAt: '2000-01-01T00:00:00.000Z' };
  assert.throws(() => resolveLifecycleExecutionPolicy({ project: legacy, action: 'quality' }), error => error.code === 'LEGACY_DESCRIPTOR_AUTHORIZATION_FORBIDDEN');
});

test('visible host adapter binds inspection and heartbeat to the exact Lease identities', async t => {
  const observations = [];
  const adapter = createVisibleHostAdapter({
    provider: 'test-codex-host',
    inspectVisibleAgent: async input => {
      observations.push(input);
      return {
        verified: true,
        status: 'running',
        assertionId: `assertion-${observations.length}`,
        observedAt: new Date().toISOString(),
        agentId: input.agentId,
        dispatchId: input.dispatchId,
        packetDigest: input.packetDigest,
        promptDigest: input.promptDigest,
        visibility: { mode: 'user-visible', surface: input.surface, inspectRef: input.inspectRef },
      };
    },
  });
  const fixture = await makeFixture({ extensions: [codexRuntimeExtension], agentAdapter: adapter, policy: { agentExecutionMode: 'conversation-visible', runtimePlugins: ['codex-conversation-runtime'], defaultRuntimePlugin: 'codex-conversation-runtime', maxConcurrency: 'auto' } });
  t.after(() => fixture.cleanup());
  await startRun(fixture, { features: [feature('visible-heartbeat')] });
  const scheduled = await fixture.harness.dispatch(fixture.projectId, 'run', { maxConcurrency: 1, runtimePluginId: 'codex-conversation-runtime' }, command(await fixture.harness.authorityStore.read(fixture.projectId, 'run')));
  const dispatch = scheduled.result.dispatches[0];
  const packet = await fixture.harness.readDispatchPacket(fixture.projectId, 'run', dispatch.dispatchId);
  const bound = await fixture.harness.bindDispatch(fixture.projectId, 'run', {
    dispatchId: dispatch.dispatchId,
    agentId: 'visible-agent',
    runtimeReceipt: { runtimePluginId: 'codex-conversation-runtime', agentId: 'visible-agent', dispatchId: dispatch.dispatchId, packetDigest: dispatch.packetDigest, resultContractDigest: dispatch.execution.result.contractDigest, prompt: { contractVersion: packet.prompt.contractVersion, codecPluginId: packet.prompt.codecPluginId, codecPluginVersion: packet.prompt.codecPluginVersion, packetDigest: packet.prompt.packetDigest, promptDigest: packet.prompt.promptDigest }, visibility: { mode: 'user-visible', surface: 'codex-task', inspectRef: 'task-visible-heartbeat' } },
  }, command(scheduled.state));
  const heartbeat = await fixture.harness.recordHeartbeat(fixture.projectId, 'run', { leaseId: bound.result.lease.leaseId, dispatchId: dispatch.dispatchId, agentId: 'visible-agent', progress: 'reviewing' }, command(bound.state));
  assert.equal(heartbeat.result.leaseId, bound.result.lease.leaseId);
  assert.equal((await fixture.harness.authorityStore.read(fixture.projectId, 'run')).leases[0].heartbeatCount, 1);
  assert.equal(observations.length, 2);
  assert.equal(observations[1].inspectRef, 'task-visible-heartbeat');
  await assert.rejects(() => fixture.harness.kernel.heartbeat(fixture.projectId, 'run', { leaseId: bound.result.lease.leaseId, agentId: 'visible-agent' }, command(heartbeat.state)), error => error.code === 'DIRECT_HEARTBEAT_DENIED');
});

test('visible host adapter rejects an unverifiable or mismatched native observation', async () => {
  const adapter = createVisibleHostAdapter({ inspectVisibleAgent: async input => ({ verified: true, status: 'running', assertionId: 'assertion-1', observedAt: new Date().toISOString(), agentId: input.agentId, dispatchId: input.dispatchId, packetDigest: input.packetDigest, promptDigest: 'f'.repeat(64), visibility: { mode: 'user-visible', surface: input.surface, inspectRef: input.inspectRef } }) });
  await assert.rejects(() => adapter.verifyVisibleLease({ agentId: 'agent-1', dispatch: { dispatchId: 'dispatch-1', packetDigest: 'a'.repeat(64) }, prompt: { promptDigest: 'b'.repeat(64) }, runtimeReceipt: { visibility: { surface: 'codex-task', inspectRef: 'task-1' } } }), error => error.code === 'VISIBLE_AGENT_HOST_PROMPT_MISMATCH');
});

test('host-orchestrated visible Runtime schedules work but never falls back to a CLI process', async t => {
  const runtime = 'codex-conversation-runtime';
  const agentAdapter = createVisibleHostAdapter({
    provider: 'test-host',
    inspectVisibleAgent: async input => ({
      verified: true,
      status: 'running',
      assertionId: 'attestation-1',
      observedAt: new Date().toISOString(),
      agentId: input.agentId,
      dispatchId: input.dispatchId,
      packetDigest: input.packetDigest,
      promptDigest: input.promptDigest,
      visibility: { mode: 'user-visible', surface: input.surface, inspectRef: input.inspectRef },
    }),
  });
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
  assert.equal(read.prompt.packetDigest, dispatch.packetDigest);
  assert.match(read.prompt.text, /^# Agent Harness Dispatch Prompt/);
  assert.match(read.prompt.text, /Return exactly one JSON object/);
  state = scheduled.state;
  await assert.rejects(() => fixture.harness.kernel.bindLease(fixture.projectId, 'run', { dispatchId: dispatch.dispatchId, agentId: 'bypass-agent', packetDigest: dispatch.packetDigest, runtimeReceipt: { runtimePluginId: runtime } }, command(state)), error => error.code === 'DIRECT_LEASE_BIND_DENIED');
  await assert.rejects(() => fixture.harness.pluginHost.invoke(runtime, 'spawn', read.packet), error => error.code === 'DIRECT_EXECUTION_PLUGIN_INVOKE_DENIED');
  await assert.rejects(() => fixture.harness.bindDispatch(fixture.projectId, 'run', { dispatchId: dispatch.dispatchId, agentId: 'visible-agent', runtimeReceipt: { runtimePluginId: runtime } }, command(state)), error => error.code === 'USER_VISIBLE_RUNTIME_RECEIPT_REQUIRED');
  const promptReceipt = { contractVersion: read.prompt.contractVersion, codecPluginId: read.prompt.codecPluginId, codecPluginVersion: read.prompt.codecPluginVersion, packetDigest: read.prompt.packetDigest, promptDigest: read.prompt.promptDigest };
  await assert.rejects(() => fixture.harness.bindDispatch(fixture.projectId, 'run', { dispatchId: dispatch.dispatchId, agentId: 'visible-agent', runtimeReceipt: { runtimePluginId: runtime, agentId: 'visible-agent', dispatchId: dispatch.dispatchId, packetDigest: dispatch.packetDigest, resultContractDigest: dispatch.execution.result.contractDigest, prompt: { ...promptReceipt, promptDigest: 'f'.repeat(64) }, visibility: { mode: 'user-visible', surface: 'codex-task', inspectRef: 'task-123' } } }, command(state)), error => error.code === 'AGENT_PROMPT_RECEIPT_DIGEST_MISMATCH');
  await assert.rejects(() => fixture.harness.bindDispatch(fixture.projectId, 'run', { dispatchId: dispatch.dispatchId, agentId: 'visible-agent', runtimeReceipt: { runtimePluginId: runtime, agentId: 'visible-agent', dispatchId: dispatch.dispatchId, packetDigest: dispatch.packetDigest, resultContractDigest: 'f'.repeat(64), prompt: promptReceipt, visibility: { mode: 'user-visible', surface: 'codex-task', inspectRef: 'task-123' } } }, command(state)), error => error.code === 'RESULT_CONTRACT_RECEIPT_MISMATCH');
  const bound = await fixture.harness.bindDispatch(fixture.projectId, 'run', { dispatchId: dispatch.dispatchId, agentId: 'visible-agent', runtimeReceipt: { runtimePluginId: runtime, agentId: 'visible-agent', dispatchId: dispatch.dispatchId, packetDigest: dispatch.packetDigest, resultContractDigest: dispatch.execution.result.contractDigest, prompt: promptReceipt, visibility: { mode: 'user-visible', surface: 'codex-task', inspectRef: 'task-123' } } }, command(state));
  assert.equal(bound.result.lease.agentId, 'visible-agent');
  assert.equal(bound.result.lease.runtimeReceipt.hostAttestation.verified, true);
  const visibleResult = {
    status: 'completed',
    summary: 'done',
    checkpoints: [{ id: 'review', status: 'passed', summary: 'reviewed', evidence: ['test-attestation'] }],
    made: [],
    notMade: [],
    changedFiles: [],
    observations: [],
    findings: [],
    followUpFeatures: [],
    failureClass: null,
    blocker: null,
  };
  await assert.rejects(() => fixture.harness.recordResult(fixture.projectId, 'run', dispatch.dispatchId, visibleResult, { commandId: command().commandId }), error => error.code === 'VISIBLE_AGENT_HEARTBEAT_REQUIRED');
});

test('explicit visible Feature dispatch binds the visible result schema', async t => {
  const runtime = 'codex-conversation-runtime';
  const fixture = await makeFixture({ extensions: [codexRuntimeExtension], policy: { agentExecutionMode: 'conversation-visible', runtimePlugins: [runtime], defaultRuntimePlugin: runtime, maxConcurrency: 'auto' } });
  t.after(() => fixture.cleanup());
  await startRun(fixture, { features: [feature('visible-candidate')] });
  const state = await fixture.harness.authorityStore.read(fixture.projectId, 'run');
  const scheduled = await fixture.harness.dispatch(fixture.projectId, 'run', { candidateFeatureIds: ['visible-candidate'], runtimePluginId: runtime }, command(state));
  const read = await fixture.harness.readDispatchPacket(fixture.projectId, 'run', scheduled.result.dispatches[0].dispatchId);
  assert.equal(read.packet.execution.runtime.mode, 'conversation-visible');
  assert.match(read.packet.execution.result.schemaId, /visible-agent-result/);
  assert.equal(read.prompt.contractVersion, '1.3');
});

test('Harness rejects unwrapped visible host callbacks instead of trusting a custom attestor', async () => {
  await assert.rejects(
    () => makeFixture({ extensions: [codexRuntimeExtension], agentAdapter: { verifyVisibleLease: async () => ({ verified: true }) } }),
    error => error.code === 'VISIBLE_AGENT_HOST_ADAPTER_REQUIRED',
  );
});

test('visible Lease binding rejects stale host observations', async t => {
  const adapter = createVisibleHostAdapter({
    inspectVisibleAgent: async input => ({
      verified: true,
      status: 'running',
      assertionId: 'stale-attestation',
      observedAt: new Date(Date.now() - 10_000).toISOString(),
      agentId: input.agentId,
      dispatchId: input.dispatchId,
      packetDigest: input.packetDigest,
      promptDigest: input.promptDigest,
      visibility: { mode: 'user-visible', surface: input.surface, inspectRef: input.inspectRef },
    }),
  });
  const fixture = await makeFixture({ extensions: [codexRuntimeExtension], agentAdapter: adapter, policy: { agentExecutionMode: 'conversation-visible', runtimePlugins: ['codex-conversation-runtime'], defaultRuntimePlugin: 'codex-conversation-runtime', visibleHeartbeatTimeoutMs: 1_000 } });
  t.after(() => fixture.cleanup());
  await startRun(fixture, { features: [feature('stale-visible-agent')] });
  const scheduled = await fixture.harness.dispatch(fixture.projectId, 'run', { maxConcurrency: 1, runtimePluginId: 'codex-conversation-runtime' }, command(await fixture.harness.authorityStore.read(fixture.projectId, 'run')));
  const dispatch = scheduled.result.dispatches[0];
  const packet = await fixture.harness.readDispatchPacket(fixture.projectId, 'run', dispatch.dispatchId);
  const prompt = { contractVersion: packet.prompt.contractVersion, codecPluginId: packet.prompt.codecPluginId, codecPluginVersion: packet.prompt.codecPluginVersion, packetDigest: packet.prompt.packetDigest, promptDigest: packet.prompt.promptDigest };
  await assert.rejects(
    () => fixture.harness.bindDispatch(fixture.projectId, 'run', { dispatchId: dispatch.dispatchId, agentId: 'stale-agent', runtimeReceipt: { runtimePluginId: 'codex-conversation-runtime', agentId: 'stale-agent', dispatchId: dispatch.dispatchId, packetDigest: dispatch.packetDigest, resultContractDigest: dispatch.execution.result.contractDigest, prompt, visibility: { mode: 'user-visible', surface: 'codex-task', inspectRef: 'stale-task' } } }, command(scheduled.state)),
    error => error.code === 'VISIBLE_AGENT_HOST_OBSERVATION_STALE',
  );
});
