import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { digestJson } from '../src/common/canonical.mjs';
import { harnessTemporaryRoot } from '../src/common/write-boundary.mjs';
import { captureHookToolResult, createHookHostExchange } from '../integrations/codex/agent-harness-codex/lib/hook-host-exchange.mjs';
import { createHostExchangeDiagnosticWriter } from '../integrations/codex/agent-harness-codex/lib/host-exchange-diagnostics.mjs';

const request = () => {
  const body = { protocolVersion: '1.0', kind: 'codex-visible-host-request', tool: 'collaboration.list_agents', arguments: {}, sessionId: 'fixture-session', requestId: `host_request_${crypto.randomUUID()}`, operation: 'inspect', binding: null, createdAt: new Date().toISOString() };
  return { ...body, requestDigest: digestJson(body) };
};

test('PostToolUse captures the exact native result for one pending request', async t => {
  const controlRoot = resolve(process.cwd());
  const parent = resolve(harnessTemporaryRoot(), 'hook-host-exchange');
  await mkdir(parent, { recursive: true });
  const dataRoot = await mkdtemp(resolve(parent, 'case-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const output = new PassThrough();
  const bridge = createHookHostExchange({ controlRoot, dataRoot, codexSessionId: 'parent-session', output, responseTimeoutMs: 1000, pollMs: 5 });
  const pendingRequest = request();
  const pending = bridge.exchange(pendingRequest);
  await once(output, 'data');
  const wrong = await captureHookToolResult({ hook_event_name: 'PostToolUse', tool_name: 'collaboration.list_agents', tool_use_id: 'tool-wrong', tool_input: { target: 'other' }, tool_response: { agents: [] } }, { controlRoot, dataRoot });
  assert.equal(wrong.captured, false);
  const otherSession = await captureHookToolResult({ hook_event_name: 'PostToolUse', tool_name: 'collaboration.list_agents', tool_use_id: 'tool-other-session', tool_input: {}, tool_response: { agents: [] }, session_id: 'another-session' }, { controlRoot, dataRoot });
  assert.equal(otherSession.captured, false);
  const captured = await captureHookToolResult({ hook_event_name: 'PostToolUse', tool_name: 'collaboration.list_agents', tool_use_id: 'tool-correct', tool_input: {}, tool_response: { agents: [] }, session_id: 'parent-session', turn_id: 'turn-1' }, { controlRoot, dataRoot });
  assert.equal(captured.captured, true);
  assert.equal(captured.requestId, pendingRequest.requestId);
  assert.deepEqual(await pending, { agents: [] });
  bridge.close();
});

test('missing Hook result times out with a bound diagnostic and closes the channel', async t => {
  const controlRoot = resolve(process.cwd());
  const parent = resolve(harnessTemporaryRoot(), 'hook-host-exchange');
  await mkdir(parent, { recursive: true });
  const dataRoot = await mkdtemp(resolve(parent, 'timeout-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const output = new PassThrough();
  const bridge = createHookHostExchange({ controlRoot, dataRoot, codexSessionId: 'parent-session', output, responseTimeoutMs: 40, pollMs: 5, onRejected: createHostExchangeDiagnosticWriter({ controlRoot, dataRoot }) });
  const pendingRequest = request();
  const pending = bridge.exchange(pendingRequest);
  await once(output, 'data');
  await assert.rejects(() => pending, error => error.code === 'CODEX_HOST_HOOK_RESPONSE_TIMEOUT' && error.details.diagnostic.file.endsWith('.json'));
  await assert.rejects(() => bridge.exchange(request()), error => error.code === 'CODEX_HOST_EXCHANGE_CLOSED');
  bridge.close();
});
