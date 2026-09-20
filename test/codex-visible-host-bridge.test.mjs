import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { createCodexCollaborationHostAdapter } from '../integrations/codex/agent-harness-codex/lib/codex-collaboration-host-adapter.mjs';
import { createStdioHostExchange } from '../integrations/codex/agent-harness-codex/lib/stdio-host-exchange.mjs';
import { createVisibleLifecycleIntent, decodeVisibleLifecycleIntent, encodeVisibleLifecycleIntent, validateVisibleLifecycleIntent } from '../integrations/codex/agent-harness-codex/lib/visible-lifecycle-intent.mjs';
import { digestJson } from '../src/common/canonical.mjs';
import { harnessTemporaryRoot } from '../src/common/write-boundary.mjs';

const businessResult = {
  status: 'completed',
  summary: 'Visible Agent completed the bounded review.',
  checkpoints: [{ id: 'review', status: 'passed', summary: 'Review completed.', evidence: ['src/example.mjs:1'] }],
  made: [], notMade: [], changedFiles: [], observations: [], findings: [], followUpFeatures: [], failureClass: null, blocker: null,
};

const setup = async (t, { spawnResult = undefined, interruptStops = true } = {}) => {
  const controlRoot = resolve(process.cwd());
  const parent = resolve(harnessTemporaryRoot(), 'codex-visible-host-bridge');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'case-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tasks = new Map();
  const requests = [];
  const exchange = async request => {
    requests.push(structuredClone(request));
    const unsigned = structuredClone(request);
    delete unsigned.requestDigest;
    assert.equal(request.requestDigest, digestJson(unsigned));
    if (request.operation === 'spawn') {
      assert.equal(request.tool, 'collaboration.spawn_agent');
      assert.equal(request.arguments.fork_turns, 'none');
      assert.equal(request.arguments.message, 'exact prompt\nwith newline');
      const result = structuredClone(spawnResult ?? { task_name: `/root/${request.arguments.task_name}` });
      tasks.set(typeof result.task_name === 'string' ? result.task_name : `/root/${request.arguments.task_name}`, 'running');
      return result;
    }
    if (request.operation === 'wait') return { message: 'Agent completed.', timed_out: false };
    if (request.operation === 'interrupt') {
      assert.equal(request.tool, 'collaboration.interrupt_agent');
      if (interruptStops && tasks.has(request.arguments.target)) tasks.set(request.arguments.target, 'interrupted');
      return { agent_name: request.arguments.target, previous_status: 'running' };
    }
    assert.equal(request.tool, 'collaboration.list_agents');
    assert.deepEqual(request.arguments, {});
    return { agents: [...tasks].map(([agent_name, agent_status]) => ({ agent_name, agent_status })) };
  };
  const create = (sessionId = 'session-fixture') => createCodexCollaborationHostAdapter({ exchange, controlRoot, dataRoot: resolve(root, 'data'), sessionId, now: () => '2026-09-15T00:00:00.000Z', waitTimeoutMs: 1000 });
  return { root, tasks, requests, exchange, create };
};

const spawnInput = { projectId: 'engine', runId: 'run-1', dispatchId: 'dispatch-1', packetDigest: 'a'.repeat(64), promptDigest: 'b'.repeat(64), prompt: 'exact prompt\nwith newline' };

test('Codex collaboration adapter binds the real native envelope, canonical task, Lease, wait, and result', async t => {
  const fixture = await setup(t);
  const host = fixture.create();
  const reconciled = await host.adapter.reconcile({ activeEffectIds: [] });
  assert.equal(reconciled.ready, true);
  const spawned = await host.adapter.spawn(spawnInput);
  assert.match(spawned.agentId, /^\/root\/ah_/);
  assert.equal(spawned.receipt.nativeTaskName, spawned.agentId);
  const runtimeReceipt = { visibility: spawned.visibility, hostSpawnReceipt: spawned.receipt };
  const observation = await host.adapter.verifyVisibleLease({ dispatch: { dispatchId: 'dispatch-1', packetDigest: 'a'.repeat(64) }, prompt: { promptDigest: 'b'.repeat(64) }, agentId: spawned.agentId, runtimeReceipt });
  assert.equal(observation.verified, true);
  await host.adapter.confirm({ ...spawnInput, agentId: spawned.agentId, runtimeReceipt });
  fixture.tasks.set(spawned.agentId, { completed: JSON.stringify(businessResult) });
  const waited = await host.adapter.wait({ agentId: spawned.agentId, dispatchId: 'dispatch-1', runtimeReceipt });
  assert.equal(waited.status, 'completed');
  const transported = await host.adapter.result({ agentId: spawned.agentId, dispatchId: 'dispatch-1', runtimeReceipt });
  assert.deepEqual(transported.result, businessResult);
  assert.equal(transported.runtimeEvidence.verificationReceipts.length, 1);
  assert.equal((await host.journal.read(spawned.receipt.effectId)).state, 'settled');
  assert.deepEqual(fixture.requests.map(request => request.operation), ['inspect', 'spawn', 'inspect', 'inspect', 'wait', 'inspect', 'inspect']);
  assert.deepEqual(Object.keys(fixture.requests.find(request => request.operation === 'spawn')).slice(0, 4), ['protocolVersion', 'kind', 'tool', 'arguments']);
});

test('native failed, interrupted, blocked, and output-less completed states become committable terminal results', async t => {
  for (const [nativeStatus, expected] of [
    [{ failed: 'provider failed the child task' }, { status: 'failed', failureClass: 'runtime-provider', code: 'CODEX_COLLABORATION_AGENT_FAILED' }],
    ['interrupted', { status: 'failed', failureClass: 'runtime-interrupted', code: 'CODEX_COLLABORATION_AGENT_INTERRUPTED' }],
    ['blocked', { status: 'blocked', failureClass: 'runtime-blocked', code: 'CODEX_COLLABORATION_AGENT_BLOCKED' }],
    ['completed', { status: 'failed', failureClass: 'runtime-contract', code: 'CODEX_COLLABORATION_RESULT_UNAVAILABLE' }],
  ]) {
    const fixture = await setup(t);
    const host = fixture.create(`terminal-${expected.code}`);
    const spawned = await host.adapter.spawn({ ...spawnInput, dispatchId: `dispatch-${expected.code}` });
    const runtimeReceipt = { visibility: spawned.visibility, hostSpawnReceipt: spawned.receipt };
    await host.adapter.confirm({ ...spawnInput, dispatchId: `dispatch-${expected.code}`, agentId: spawned.agentId, runtimeReceipt });
    fixture.tasks.set(spawned.agentId, nativeStatus);
    const waited = await host.adapter.wait({ agentId: spawned.agentId, dispatchId: `dispatch-${expected.code}`, runtimeReceipt });
    assert.equal(waited.status, expected.status);
    const transported = await host.adapter.result({ agentId: spawned.agentId, dispatchId: `dispatch-${expected.code}`, runtimeReceipt });
    assert.equal(transported.result.status, expected.status);
    assert.equal(transported.result.failureClass, expected.failureClass);
    assert.equal(transported.result.blocker.code, expected.code);
    assert.equal((await host.journal.read(spawned.receipt.effectId)).state, 'settled');
  }
});

test('Codex adapter records invalid native output as a bound terminal failure', async t => {
  const fixture = await setup(t);
  const host = fixture.create('invalid-result-schema');
  const spawned = await host.adapter.spawn(spawnInput);
  const runtimeReceipt = { visibility: spawned.visibility, hostSpawnReceipt: spawned.receipt };
  await host.adapter.confirm({ ...spawnInput, agentId: spawned.agentId, runtimeReceipt });
  fixture.tasks.set(spawned.agentId, { completed: JSON.stringify({ status: 'completed', summary: 'missing changedFiles' }) });
  const transported = await host.adapter.result({ agentId: spawned.agentId, dispatchId: spawnInput.dispatchId, runtimeReceipt });
  assert.equal(transported.result.status, 'failed');
  assert.equal(transported.result.blocker.code, 'CODEX_COLLABORATION_RESULT_SCHEMA_INVALID');
  assert.match(transported.runtimeEvidence.resultRejection.nativeOutputDigest, /^[a-f0-9]{64}$/);
  assert.equal(transported.runtimeEvidence.resultRejection.kind, 'result-rejected-receipt');
  assert.equal(transported.runtimeEvidence.resultRejection.version, '1.0');
  assert.equal(transported.receipt.rejectionDigest, transported.runtimeEvidence.resultRejection.receiptDigest);
  assert.equal((await host.journal.read(spawned.receipt.effectId)).state, 'settled');
});

test('Codex visible adapter transports declared typed outputs without applying the CLI provider schema', async t => {
  const fixture = await setup(t);
  const host = fixture.create('typed-output');
  const spawned = await host.adapter.spawn(spawnInput);
  const runtimeReceipt = { visibility: spawned.visibility, hostSpawnReceipt: spawned.receipt };
  await host.adapter.confirm({ ...spawnInput, agentId: spawned.agentId, runtimeReceipt });
  const typed = { status: 'completed', summary: 'Question parsed.', changedFiles: [], outputs: { question: { schemaId: 'question-v1', value: { question: 'What changed?' }, evidenceRefs: [] } } };
  fixture.tasks.set(spawned.agentId, { completed: JSON.stringify(typed) });
  const transported = await host.adapter.result({ agentId: spawned.agentId, dispatchId: spawnInput.dispatchId, runtimeReceipt });
  assert.deepEqual(transported.result, typed);
});

test('malformed completed native output becomes a terminal contract failure with its raw digest', async t => {
  const fixture = await setup(t);
  const host = fixture.create('malformed-output');
  const spawned = await host.adapter.spawn(spawnInput);
  const runtimeReceipt = { visibility: spawned.visibility, hostSpawnReceipt: spawned.receipt };
  await host.adapter.confirm({ ...spawnInput, agentId: spawned.agentId, runtimeReceipt });
  fixture.tasks.set(spawned.agentId, { completed: 'not JSON' });
  const transported = await host.adapter.result({ agentId: spawned.agentId, dispatchId: spawnInput.dispatchId, runtimeReceipt });
  assert.equal(transported.result.status, 'failed');
  assert.equal(transported.runtimeEvidence.resultRejection.code, 'CODEX_COLLABORATION_RESULT_JSON_INVALID');
  assert.equal((await host.journal.read(spawned.receipt.effectId)).state, 'settled');
});

test('legacy provider identity spawn envelope fails closed and the spawned Agent is interrupted before return', async t => {
  const fixture = await setup(t, { spawnResult: { agent_id: 'provider-agent-1', nickname: 'Ada' } });
  const host = fixture.create();
  await assert.rejects(() => host.adapter.spawn(spawnInput), error => error.code === 'CODEX_COLLABORATION_SPAWN_RESULT_INVALID' && error.details?.containment?.disposition === 'interrupted');
  assert.equal(fixture.requests.filter(request => request.operation === 'interrupt').length, 1);
  assert.equal((await host.journal.list())[0].state, 'contained');
});

test('spawn task identity mismatch fails closed and contains the returned Agent', async t => {
  const fixture = await setup(t, { spawnResult: { task_name: '/root/unrelated-task' } });
  const host = fixture.create();
  await assert.rejects(() => host.adapter.spawn(spawnInput), error => error.code === 'CODEX_COLLABORATION_TASK_NAME_MISMATCH' && error.details?.containment?.disposition === 'interrupted');
  assert.equal(fixture.requests.filter(request => request.operation === 'interrupt').length, 1);
  assert.equal(fixture.tasks.get('/root/unrelated-task'), 'interrupted');
  assert.equal((await host.journal.list())[0].state, 'contained');
});

test('preflight reconciliation contains a crash-window Agent before any later spawn', async t => {
  const fixture = await setup(t);
  const first = fixture.create('crashed-session');
  const taskName = 'ah_crash_window_fixture';
  const requestBody = { protocolVersion: '1.0', kind: 'codex-visible-host-request', sessionId: 'crashed-session', requestId: 'host_request_crash', operation: 'spawn', tool: 'collaboration.spawn_agent', arguments: { task_name: taskName, fork_turns: 'none', message: 'prompt' }, binding: { projectId: 'engine', runId: 'run-1', dispatchId: 'dispatch-crash', packetDigest: 'c'.repeat(64), promptDigest: 'd'.repeat(64) }, createdAt: '2026-09-15T00:00:00.000Z' };
  const request = { ...requestBody, requestDigest: digestJson(requestBody) };
  await first.journal.prepare({ request, taskName, binding: request.binding });
  fixture.tasks.set(`/root/${taskName}`, 'running');
  const restarted = fixture.create('restarted-session');
  const reconciled = await restarted.adapter.reconcile({ activeEffectIds: [] });
  assert.equal(reconciled.ready, true);
  assert.equal(fixture.tasks.get(`/root/${taskName}`), 'interrupted');
  assert.equal((await restarted.journal.unresolved()).length, 0);
  assert.equal(fixture.requests.filter(item => item.operation === 'interrupt').length, 1);
});

test('unverified containment blocks preflight and leaves the Host Effect unresolved', async t => {
  const fixture = await setup(t, { interruptStops: false });
  const host = fixture.create();
  const taskName = 'ah_uncontained_fixture';
  const requestBody = { protocolVersion: '1.0', kind: 'codex-visible-host-request', sessionId: 'session-fixture', requestId: 'host_request_uncontained', operation: 'spawn', tool: 'collaboration.spawn_agent', arguments: { task_name: taskName, fork_turns: 'none', message: 'prompt' }, binding: { projectId: 'engine', runId: 'run-1', dispatchId: 'dispatch-uncontained', packetDigest: 'e'.repeat(64), promptDigest: 'f'.repeat(64) }, createdAt: '2026-09-15T00:00:00.000Z' };
  const request = { ...requestBody, requestDigest: digestJson(requestBody) };
  await host.journal.prepare({ request, taskName, binding: request.binding });
  fixture.tasks.set(`/root/${taskName}`, 'running');
  const reconciled = await host.adapter.reconcile({ activeEffectIds: [] });
  assert.equal(reconciled.ready, false);
  assert.equal(reconciled.issues[0].code, 'CODEX_COLLABORATION_CONTAINMENT_UNVERIFIED');
  assert.equal((await host.journal.unresolved()).length, 1);
});

test('Codex collaboration adapter rejects a forged cross-Dispatch spawn Receipt before attestation', async t => {
  const fixture = await setup(t);
  const host = fixture.create();
  const spawned = await host.adapter.spawn(spawnInput);
  const forged = structuredClone(spawned.receipt);
  forged.dispatchId = 'dispatch-2';
  await assert.rejects(() => host.adapter.verifyVisibleLease({ dispatch: { dispatchId: 'dispatch-1', packetDigest: 'a'.repeat(64) }, prompt: { promptDigest: 'b'.repeat(64) }, agentId: spawned.agentId, runtimeReceipt: { visibility: spawned.visibility, hostSpawnReceipt: forged } }), error => error.code === 'CODEX_COLLABORATION_SPAWN_RECEIPT_DIGEST_MISMATCH');
});

test('stdio Host exchange accepts only the exact pending request envelope', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const transport = createStdioHostExchange({ input, output });
  const request = { protocolVersion: '1.0', kind: 'codex-visible-host-request', sessionId: 'session', requestId: 'request', requestDigest: 'a'.repeat(64), operation: 'inspect', tool: 'collaboration.list_agents', arguments: {}, binding: null, createdAt: '2026-09-15T00:00:00.000Z' };
  const pending = transport.exchange(request);
  const [bytes] = await once(output, 'data');
  assert.deepEqual(JSON.parse(bytes.toString()), request);
  input.write(`${JSON.stringify({ protocolVersion: '1.0', kind: 'codex-visible-host-response', sessionId: 'session', requestId: 'request', requestDigest: 'wrong', operation: 'inspect', tool: 'collaboration.list_agents', result: { agents: [] } })}\n`);
  await assert.rejects(pending, error => error.code === 'CODEX_HOST_RESPONSE_BINDING_MISMATCH');
  transport.close();
});

test('Hook-visible lifecycle intents are short-lived, digest-bound, and safe as one base64url argument', () => {
  const intent = createVisibleLifecycleIntent({
    harness: { controlRoot: 'F:\\agent-harness', dataRoot: 'F:\\agent-harness\\data', entrypoint: 'F:\\agent-harness\\runtime\\bin\\agent-harness.mjs', release: { version: '1.0.0', artifactDigest: 'a'.repeat(64), generationId: 'g-1', pointerDigest: 'b'.repeat(64) } },
    project: { projectId: 'engine', profileId: 'engine-delivery', extensionId: 'engine-profile' },
    command: { action: 'quality', target: 'V3.8.4', arguments: ['full'] },
    executionWorkspaceRoot: 'F:\\CardWorld',
    coordinatorEntrypoint: 'F:\\agent-harness\\runtime\\integrations\\codex\\agent-harness-codex\\scripts\\visible-lifecycle-coordinator.mjs',
    now: () => '2026-09-15T00:00:00.000Z',
  });
  const encoded = encodeVisibleLifecycleIntent(intent);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeVisibleLifecycleIntent(encoded, { now: () => '2026-09-15T00:01:00.000Z' }), intent);
  const forged = structuredClone(intent);
  forged.command.target = 'V9.9.9';
  assert.throws(() => validateVisibleLifecycleIntent(forged, { now: () => '2026-09-15T00:01:00.000Z' }), error => error.code === 'VISIBLE_LIFECYCLE_INTENT_DIGEST_MISMATCH');
  assert.throws(() => validateVisibleLifecycleIntent(intent, { now: () => '2026-09-15T00:06:00.000Z' }), error => error.code === 'VISIBLE_LIFECYCLE_INTENT_EXPIRED');
});
