import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { digestJson } from '../src/common/canonical.mjs';
import { harnessTemporaryRoot } from '../src/common/write-boundary.mjs';
import { createCodexRolloutHostExchange, locateCodexRollout } from '../integrations/codex/agent-harness-codex/lib/codex-rollout-host-exchange.mjs';

const sessionId = 'fixture-session';
const makeRequest = () => {
  const body = { protocolVersion: '1.0', kind: 'codex-visible-host-request', tool: 'collaboration.list_agents', arguments: {}, sessionId, requestId: `rollout_${crypto.randomUUID()}`, operation: 'inspect', binding: null, createdAt: new Date().toISOString() };
  return { ...body, requestDigest: digestJson(body) };
};
const line = payload => `${JSON.stringify({ timestamp: new Date().toISOString(), ordinal: 1, type: 'response_item', payload })}\n`;

const fixture = async t => {
  const controlRoot = resolve(process.cwd());
  const parent = resolve(harnessTemporaryRoot(), 'codex-rollout-host-tests');
  await mkdir(parent, { recursive: true });
  const dataRoot = await mkdtemp(resolve(parent, 'case-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const codexHome = resolve(dataRoot, '.codex');
  const sessions = resolve(codexHome, 'sessions', '2026', '09', '24');
  await mkdir(sessions, { recursive: true });
  const rollout = resolve(sessions, `rollout-${sessionId}.jsonl`);
  await writeFile(rollout, line({ type: 'function_call_output', call_id: 'old-call', output: '{"agents":[]}' }));
  const database = new DatabaseSync(resolve(codexHome, 'state_5.sqlite'));
  database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, cwd TEXT NOT NULL, cli_version TEXT NOT NULL)');
  database.prepare('INSERT INTO threads (id, rollout_path, cwd, cli_version) VALUES (?, ?, ?, ?)').run(sessionId, rollout, controlRoot, 'fixture-codex');
  database.close();
  return { controlRoot, dataRoot, codexHome, rollout };
};

test('rollout Host exchange binds one native function output to a fresh request and records its receipt', async t => {
  const { controlRoot, dataRoot, codexHome, rollout } = await fixture(t);
  const output = new PassThrough();
  const exchange = createCodexRolloutHostExchange({ controlRoot, dataRoot, codexHome, codexSessionId: sessionId, expectedCwd: controlRoot, output, responseTimeoutMs: 1000, pollMs: 5 });
  const request = makeRequest();
  const pending = exchange.exchange(request);
  const [chunk] = await once(output, 'data');
  assert.deepEqual(JSON.parse(chunk.toString()), request);
  await appendFile(rollout, line({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"agents":[{"agent_name":"forged"}]}' }] }));
  await appendFile(rollout, line({ type: 'function_call', namespace: 'collaboration', name: 'list_agents', call_id: 'call-wrong', arguments: '{"target":"other"}', internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' } }));
  await appendFile(rollout, line({ type: 'function_call_output', id: 'fco-wrong', call_id: 'call-wrong', output: '{"agents":[]}', internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' } }));
  await appendFile(rollout, line({ type: 'function_call', namespace: 'collaboration', name: 'list_agents', call_id: 'call-correct', arguments: '{}', internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' } }));
  await appendFile(rollout, line({ type: 'function_call_output', id: 'fco-correct', call_id: 'call-correct', output: '{"agents":[{"agent_name":"/root","agent_status":"running"}]}', internal_chat_message_metadata_passthrough: { turn_id: 'turn-1', executed_tool_calls: [{ name: 'collaboration__list_agents', arguments: {} }] } }));
  assert.deepEqual(await pending, { agents: [{ agent_name: '/root', agent_status: 'running' }] });
  const files = await readdir(resolve(dataRoot, 'host-bridge', 'rollout-receipts'));
  assert.equal(files.length, 1);
  const receipt = JSON.parse(await readFile(resolve(dataRoot, 'host-bridge', 'rollout-receipts', files[0]), 'utf8'));
  assert.equal(receipt.callId, 'call-correct');
  assert.equal(receipt.requestDigest, request.requestDigest);
  exchange.close();
});

test('rollout Host exchange rejects an ambiguous native call and an unbound session', async t => {
  const { controlRoot, dataRoot, codexHome, rollout } = await fixture(t);
  const output = new PassThrough();
  const exchange = createCodexRolloutHostExchange({ controlRoot, dataRoot, codexHome, codexSessionId: sessionId, expectedCwd: controlRoot, output, responseTimeoutMs: 1000, pollMs: 5 });
  const pending = exchange.exchange(makeRequest());
  await once(output, 'data');
  await appendFile(rollout, line({ type: 'function_call', namespace: 'collaboration', name: 'list_agents', call_id: 'call-one', arguments: '{}', internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' } }));
  await appendFile(rollout, line({ type: 'function_call', namespace: 'collaboration', name: 'list_agents', call_id: 'call-two', arguments: '{}', internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' } }));
  await assert.rejects(() => pending, { code: 'CODEX_ROLLOUT_CALL_AMBIGUOUS' });
  exchange.close();
  await assert.rejects(() => locateCodexRollout({ codexHome, codexSessionId: 'other-session', expectedCwd: controlRoot }), { code: 'CODEX_ROLLOUT_SESSION_NOT_BOUND' });
});

test('rollout Host exchange records the limited attestation of a redacted native spawn', async t => {
  const { controlRoot, dataRoot, codexHome, rollout } = await fixture(t);
  const binding = { projectId: 'fixture', runId: 'run-1', dispatchId: 'dispatch-1', packetDigest: 'a'.repeat(64), promptDigest: 'b'.repeat(64) };
  const argumentsForSpawn = { task_name: `ah_${digestJson({ sessionId, ...binding }).slice(0, 20)}`, fork_turns: 'none', message: 'exact generated Prompt text' };
  const body = { protocolVersion: '1.0', kind: 'codex-visible-host-request', tool: 'collaboration.spawn_agent', arguments: argumentsForSpawn, sessionId, requestId: `rollout_${crypto.randomUUID()}`, operation: 'spawn', binding, createdAt: new Date().toISOString() };
  const request = { ...body, requestDigest: digestJson(body) };
  const output = new PassThrough();
  const exchange = createCodexRolloutHostExchange({ controlRoot, dataRoot, codexHome, codexSessionId: sessionId, expectedCwd: controlRoot, output, responseTimeoutMs: 1000, pollMs: 5 });
  const pending = exchange.exchange(request);
  await once(output, 'data');
  await appendFile(rollout, line({ type: 'function_call', namespace: 'collaboration', name: 'spawn_agent', call_id: 'spawn-call', arguments: JSON.stringify({ ...argumentsForSpawn, message: `gAAAA${'a'.repeat(80)}` }), internal_chat_message_metadata_passthrough: { turn_id: 'turn-spawn' } }));
  await appendFile(rollout, line({ type: 'function_call_output', id: 'spawn-output', call_id: 'spawn-call', output: JSON.stringify({ task_name: `/root/${argumentsForSpawn.task_name}` }), internal_chat_message_metadata_passthrough: { turn_id: 'turn-spawn', executed_tool_calls: [{ name: 'collaboration__spawn_agent', arguments: { _codex_executed_tool_call_truncated: { original_bytes: 9000, max_bytes: 8192 } } }] } }));
  assert.deepEqual(await pending, { task_name: `/root/${argumentsForSpawn.task_name}` });
  const files = await readdir(resolve(dataRoot, 'host-bridge', 'rollout-receipts'));
  const receipt = JSON.parse(await readFile(resolve(dataRoot, 'host-bridge', 'rollout-receipts', files[0]), 'utf8'));
  assert.equal(receipt.argumentAttestation, 'host-redacted-message');
  assert.equal(receipt.callId, 'spawn-call');
  exchange.close();
});
