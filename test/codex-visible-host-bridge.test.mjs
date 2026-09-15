import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { createCodexCollaborationHostAdapter } from '../integrations/codex/agent-harness-codex/lib/codex-collaboration-host-adapter.mjs';
import { createStdioHostExchange } from '../integrations/codex/agent-harness-codex/lib/stdio-host-exchange.mjs';
import { createVisibleLifecycleIntent, decodeVisibleLifecycleIntent, encodeVisibleLifecycleIntent, validateVisibleLifecycleIntent } from '../integrations/codex/agent-harness-codex/lib/visible-lifecycle-intent.mjs';
import { digestJson } from '../src/canonical.mjs';

const businessResult = {
  status: 'completed',
  summary: 'Visible Agent completed the bounded review.',
  checkpoints: [{ id: 'review', status: 'passed', summary: 'Review completed.', evidence: ['src/example.mjs:1'] }],
  made: [],
  notMade: [],
  changedFiles: [],
  observations: [],
  findings: [],
  followUpFeatures: [],
  failureClass: null,
  blocker: null,
};

test('Codex collaboration adapter preserves the exact generated prompt and re-observes the native child task', async () => {
  const requests = [];
  let canonicalTask;
  let status = 'running';
  const exchange = async request => {
    requests.push(structuredClone(request));
    const unsigned = structuredClone(request);
    delete unsigned.requestDigest;
    assert.equal(request.requestDigest, digestJson(unsigned));
    if (request.operation === 'spawn') {
      assert.equal(request.tool, 'collaboration.spawn_agent');
      assert.equal(request.arguments.fork_turns, 'none');
      assert.equal(request.arguments.message, 'exact prompt\nwith newline');
      canonicalTask = `/root/${request.arguments.task_name}`;
      return { task_name: canonicalTask };
    }
    if (request.operation === 'wait') return { message: 'Agent completed.', timed_out: false };
    assert.equal(request.tool, 'collaboration.list_agents');
    assert.equal(request.arguments.path_prefix, canonicalTask);
    return { agents: [{ agent_name: canonicalTask, agent_status: status === 'completed' ? { completed: JSON.stringify(businessResult) } : status }] };
  };
  const host = createCodexCollaborationHostAdapter({ exchange, sessionId: 'session-fixture', now: () => '2026-09-15T00:00:00.000Z', waitTimeoutMs: 1000 });
  const spawned = await host.adapter.spawn({ dispatchId: 'dispatch-1', packetDigest: 'a'.repeat(64), promptDigest: 'b'.repeat(64), prompt: 'exact prompt\nwith newline' });
  const runtimeReceipt = { visibility: spawned.visibility, hostSpawnReceipt: spawned.receipt };
  const observation = await host.adapter.verifyVisibleLease({ dispatch: { dispatchId: 'dispatch-1', packetDigest: 'a'.repeat(64) }, prompt: { promptDigest: 'b'.repeat(64) }, agentId: spawned.agentId, runtimeReceipt });
  assert.equal(observation.verified, true);
  assert.equal(observation.agentId, canonicalTask);
  status = 'completed';
  const waited = await host.adapter.wait({ agentId: canonicalTask, dispatchId: 'dispatch-1', visibility: spawned.visibility });
  assert.equal(waited.status, 'completed');
  const transported = await host.adapter.result({ agentId: canonicalTask, dispatchId: 'dispatch-1', visibility: spawned.visibility });
  assert.deepEqual(transported.result, businessResult);
  assert.equal(transported.runtimeEvidence.verificationReceipts.length, 1);
  assert.deepEqual(requests.map(request => request.operation), ['spawn', 'inspect', 'wait', 'inspect', 'inspect']);
});

test('Codex collaboration adapter rejects a forged or cross-Dispatch spawn Receipt before attestation', async () => {
  let canonicalTask;
  const exchange = async request => {
    if (request.operation === 'spawn') {
      canonicalTask = `/root/${request.arguments.task_name}`;
      return { task_name: canonicalTask };
    }
    return { agents: [{ agent_name: canonicalTask, agent_status: 'running' }] };
  };
  const host = createCodexCollaborationHostAdapter({ exchange, sessionId: 'session-fixture', now: () => '2026-09-15T00:00:00.000Z' });
  const spawned = await host.adapter.spawn({ dispatchId: 'dispatch-1', packetDigest: 'a'.repeat(64), promptDigest: 'b'.repeat(64), prompt: 'prompt' });
  const forged = structuredClone(spawned.receipt);
  forged.dispatchId = 'dispatch-2';
  await assert.rejects(
    () => host.adapter.verifyVisibleLease({ dispatch: { dispatchId: 'dispatch-1', packetDigest: 'a'.repeat(64) }, prompt: { promptDigest: 'b'.repeat(64) }, agentId: spawned.agentId, runtimeReceipt: { visibility: spawned.visibility, hostSpawnReceipt: forged } }),
    error => error.code === 'CODEX_COLLABORATION_SPAWN_RECEIPT_DIGEST_MISMATCH',
  );
});

test('stdio Host exchange accepts only the exact pending request envelope', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const transport = createStdioHostExchange({ input, output });
  const request = { protocolVersion: '1.0', kind: 'codex-visible-host-request', sessionId: 'session', requestId: 'request', requestDigest: 'a'.repeat(64), operation: 'inspect', tool: 'collaboration.list_agents', arguments: { path_prefix: '/root/task' }, binding: null, createdAt: '2026-09-15T00:00:00.000Z' };
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
