import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { createInMemoryRuntime, createProcessRuntime, DEFAULT_PROCESS_OUTPUTS, PluginHost } from '../src/index.mjs';
import { createCodexRuntime } from '../integrations/codex/runtime/codex-runtime.mjs';
import { makeFixture } from './test-support.mjs';

const memoryManifest = { id: 'memory-non-codex-runtime', kind: 'agent-runtime', version: '1.0.0', capabilities: ['spawn', 'wait', 'send', 'heartbeat', 'interrupt', 'headless'], permissions: [] };

test('Codex and non-Codex runtimes satisfy the same lifecycle contract', async () => {
  const host = new PluginHost({ allowedPermissions: ['agent.conversation'] });
  const codex = createCodexRuntime({
    async spawn() { return { agentId: 'codex-agent', transportReceipt: { provider: 'codex' } }; },
    async wait() { return { status: 'completed', result: { status: 'completed' } }; },
    async send() { return { accepted: true }; },
    async heartbeat() { return { observed: true }; },
    async interrupt() { return { interrupted: true }; },
  });
  const memory = createInMemoryRuntime({ manifest: memoryManifest, handler: async packet => ({ status: 'completed', summary: packet.dispatchId }) });
  host.register({ id: 'codex-conversation-runtime', kind: 'agent-runtime', version: '1.0.0', capabilities: ['spawn', 'wait', 'send', 'heartbeat', 'interrupt', 'user-visible', 'host-orchestrated'], permissions: ['agent.conversation'] }, codex);
  host.register(memoryManifest, memory);
  const packet = { dispatchId: 'd1' };
  const codexSpawn = await host.invoke('codex-conversation-runtime', 'spawn', packet);
  const memorySpawn = await host.invoke('memory-non-codex-runtime', 'spawn', packet);
  for (const output of [codexSpawn, memorySpawn]) {
    assert.equal(output.type, 'receipt');
    assert.equal(output.payload.operation, 'spawn');
    assert.ok(output.payload.agentId);
    assert.equal(output.payload.transportReceipt.runtimePluginId, output.pluginId);
  }
  const memoryWait = await host.invoke('memory-non-codex-runtime', 'wait', { agentId: memorySpawn.payload.agentId });
  assert.equal(memoryWait.payload.status, 'completed');
});

test('plugin host rejects direct Authority mutation envelopes', async () => {
  const host = new PluginHost();
  const manifest = { id: 'malicious-scheduler', kind: 'scheduler', version: '1.0.0', capabilities: [], permissions: [] };
  host.register(manifest, { async select() { return { type: 'intent', pluginId: manifest.id, pluginVersion: manifest.version, payload: { authorityWrite: { status: 'closed' } } }; } });
  await assert.rejects(() => host.invoke(manifest.id, 'select', {}), error => error.code === 'PLUGIN_AUTHORITY_WRITE_REJECTED');
});

test('local process runtime is a non-Codex provider with structured receipts', async t => {
  const fixture = await makeFixture(); t.after(() => fixture.cleanup());
  const manifest = { id: 'local-process-runtime', kind: 'agent-runtime', version: '1.0.0', capabilities: ['spawn', 'wait', 'send', 'heartbeat', 'interrupt', 'managed-outputs', 'headless'], permissions: ['process.spawn'], execution: { outputs: DEFAULT_PROCESS_OUTPUTS, sandbox: { mode: 'optional' } } };
  const runtime = createProcessRuntime({ manifest, executable: process.execPath, args: ['test/fixtures/process-agent.mjs'], cwd: process.cwd(), temporaryRoot: resolve(fixture.dataRoot, 'tmp', 'process-runtime') });
  const spawned = await runtime.spawn({ dispatchId: 'process-dispatch' });
  const waited = await runtime.wait({ agentId: spawned.payload.agentId });
  assert.equal(waited.payload.exitCode, 0);
  assert.match(waited.payload.stdout, /processed:process-dispatch/);
  assert.ok(JSON.parse(waited.payload.stdout).temp.startsWith(fixture.dataRoot));
});
