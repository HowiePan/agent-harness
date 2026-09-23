import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { capturePostToolUse } from '../integrations/codex/agent-harness-codex/hooks/post-tool-host-bridge.mjs';

const event = {
  hook_event_name: 'PostToolUse',
  tool_name: 'list_agents',
  tool_use_id: 'tool-bootstrap-test',
  tool_input: {},
  tool_response: { agents: [] },
  session_id: 'session-bootstrap-test',
  turn_id: 'turn-bootstrap-test',
};

const setup = async t => {
  const controlRoot = await mkdtemp(resolve(tmpdir(), 'agent-harness-hook-bootstrap-'));
  const dataRoot = resolve(controlRoot, 'data');
  const pluginRoot = resolve(controlRoot, 'plugin');
  const pluginData = resolve(pluginRoot, '.plugin-data');
  await mkdir(dataRoot, { recursive: true });
  await mkdir(pluginData, { recursive: true });
  await writeFile(resolve(pluginData, 'bindings.json'), `${JSON.stringify({ protocolVersion: '1.0', harness: { controlRoot, dataRoot } })}\n`, 'utf8');
  t.after(() => rm(controlRoot, { recursive: true, force: true }));
  const bindings = {
    harness: {
      controlRoot,
      dataRoot,
      hostBridgeModule: resolve(controlRoot, 'runtime', 'hook-host-exchange.mjs'),
      release: { artifactDigest: 'a'.repeat(64), channelArtifactDigest: 'b'.repeat(64) },
    },
  };
  return { controlRoot, dataRoot, pluginRoot, pluginData, bindings };
};

const stages = async dataRoot => {
  const root = resolve(dataRoot, 'diagnostics', 'codex-host-hook');
  const invocations = await readdir(root);
  assert.equal(invocations.length, 1);
  const files = (await readdir(resolve(root, invocations[0]))).sort();
  return Promise.all(files.map(async file => JSON.parse(await readFile(resolve(root, invocations[0], file), 'utf8'))));
};

test('PostToolUse bootstrap records every successful cache-to-runtime bridge stage', async t => {
  const fixture = await setup(t);
  const result = await capturePostToolUse(event, {
    pluginRoot: fixture.pluginRoot,
    pluginData: fixture.pluginData,
    bindings: fixture.bindings,
    bridge: { captureHookToolResult: async () => ({ captured: true, requestId: 'host_request_bootstrap', toolUseId: event.tool_use_id }) },
  });
  assert.equal(result.captured, true);
  const receipts = await stages(fixture.dataRoot);
  assert.deepEqual(receipts.map(receipt => receipt.stage), ['hook-entered', 'event-parsed', 'bindings-resolved', 'bridge-module-loaded', 'pending-request-matched', 'response-committed', 'completed']);
  assert.equal(receipts.every(receipt => /^[a-f0-9]{64}$/.test(receipt.receiptDigest)), true);
  assert.equal(receipts.some(receipt => Object.hasOwn(receipt, 'toolResponse')), false);
});

test('PostToolUse bootstrap preserves a precise pending-match failure without a timeout', async t => {
  const fixture = await setup(t);
  const result = await capturePostToolUse(event, {
    pluginRoot: fixture.pluginRoot,
    pluginData: fixture.pluginData,
    bindings: fixture.bindings,
    bridge: { captureHookToolResult: async () => ({ captured: false, reasonCode: 'CODEX_HOST_HOOK_PENDING_NOT_MATCHED' }) },
  });
  assert.deepEqual(result, { captured: false, reasonCode: 'CODEX_HOST_HOOK_PENDING_NOT_MATCHED' });
  const receipts = await stages(fixture.dataRoot);
  assert.equal(receipts.at(-1).stage, 'failed');
  assert.equal(receipts.at(-1).failureCode, 'CODEX_HOST_HOOK_PENDING_NOT_MATCHED');
});
