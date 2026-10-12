import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digestJson, sha256 } from '../src/common/canonical.mjs';
import { harnessTemporaryRoot } from '../src/common/write-boundary.mjs';
import { readCodexRolloutObservation } from '../integrations/codex/agent-harness-codex/lib/codex-rollout-host-exchange.mjs';

test('historical native observation requires the original call, output, receipt, and completed Agent', async t => {
  const parent = resolve(harnessTemporaryRoot(), 'historical-observation-tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'case-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = resolve(root, 'data');
  const receiptRoot = resolve(dataRoot, 'host-bridge', 'rollout-receipts');
  await mkdir(receiptRoot, { recursive: true });
  const rolloutPath = resolve(root, 'rollout.jsonl');
  const result = { status: 'completed', summary: 'Finished work.', changedFiles: ['docs/engine_design.md'] };
  const observation = { agents: [{ agent_name: '/root/agent', agent_status: { completed: JSON.stringify(result) } }] };
  const turnId = 'turn-1';
  const call = { type: 'response_item', ordinal: 1, payload: { type: 'function_call', namespace: 'collaboration',
    name: 'list_agents', call_id: 'call-1', arguments: '{}', internal_chat_message_metadata_passthrough: { turn_id: turnId } } };
  const output = { type: 'response_item', ordinal: 2, payload: { type: 'function_call_output', call_id: 'call-1',
    id: 'output-1', output: JSON.stringify(observation), internal_chat_message_metadata_passthrough: { turn_id: turnId } } };
  await writeFile(rolloutPath, `${JSON.stringify(call)}\n${JSON.stringify(output)}\n`);
  const requestDigest = 'a'.repeat(64);
  const body = { protocolVersion: '1.0', kind: 'codex-rollout-host-receipt', sessionId: 'session-1', requestDigest,
    tool: 'collaboration.list_agents', callId: 'call-1', outputId: 'output-1', turnId,
    ordinal: 2, argumentsDigest: digestJson({}), resultDigest: digestJson(observation),
    rolloutPathDigest: sha256(rolloutPath), codexVersion: 'test' };
  const receipt = { ...body, receiptDigest: digestJson(body) };
  await writeFile(resolve(receiptRoot, 'host_request_fixture-1.json'), JSON.stringify(receipt));
  const input = { controlRoot: process.cwd(), dataRoot, sessionId: 'session-1', expectedCwd: root,
    observationRequestDigest: requestDigest, agentId: '/root/agent',
    locate: async () => ({ path: rolloutPath, cliVersion: 'test' }) };
  assert.deepEqual((await readCodexRolloutObservation(input)).result, result);
  await writeFile(rolloutPath, `${JSON.stringify(call)}\n${JSON.stringify({ ...output,
    payload: { ...output.payload, output: JSON.stringify({ agents: [] }) } })}\n`);
  await assert.rejects(() => readCodexRolloutObservation(input),
    error => error.code === 'CODEX_ROLLOUT_HISTORICAL_OUTPUT_MISMATCH');
});
