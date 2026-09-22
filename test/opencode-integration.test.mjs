import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import {
  createOpenCodeVisibleHostAdapter,
  OPENCODE_HOST_PROVIDER,
  createOpenCodePlugin,
} from '../integrations/opencode/src/index.mjs';
import { createWriteGuard } from '../integrations/opencode/src/guard.mjs';
import { createOpenCodeTools } from '../integrations/opencode/src/tools.mjs';
import { isVisibleHostAdapter } from '../src/platform/plugins/runtime/visible-host-adapter.mjs';

const nativeCapabilities = (overrides = {}) => ({
  spawnTask: async input => ({ agentId: 'opencode-native-1', visibility: { mode: 'user-visible', surface: 'opencode-subagent', inspectRef: 'task:opencode-native-1' }, hostSpawnReceipt: { provider: OPENCODE_HOST_PROVIDER, dispatchId: input.dispatchId } }),
  inspectTask: async input => ({ verified: true, status: 'running', assertionId: 'opencode-native-observation', observedAt: new Date().toISOString(), agentId: input.agentId, dispatchId: input.dispatchId, packetDigest: input.packetDigest, promptDigest: input.promptDigest, visibility: { mode: 'user-visible', surface: input.surface, inspectRef: input.inspectRef } }),
  waitTask: async () => ({ status: 'completed', progress: '100%' }),
  resultTask: async () => ({ result: { status: 'completed', summary: 'native result', changedFiles: [] }, receipt: { provider: OPENCODE_HOST_PROVIDER } }),
  cancelTask: async () => ({ contained: true, provider: OPENCODE_HOST_PROVIDER }),
  reconcileHostEffects: async () => ({ reconciled: true, ready: true, provider: OPENCODE_HOST_PROVIDER }),
  confirmLease: async () => ({ confirmed: true, provider: OPENCODE_HOST_PROVIDER }),
  ...overrides,
});

test('OpenCode host adapter fails closed without every native capability', () => {
  assert.throws(() => createOpenCodeVisibleHostAdapter(), error => error.code === 'OPENCODE_VISIBLE_HOST_CAPABILITIES_REQUIRED');
});

test('OpenCode host adapter conforms only with a complete native contract', async () => {
  const adapter = createOpenCodeVisibleHostAdapter(nativeCapabilities());
  assert.equal(isVisibleHostAdapter(adapter), true);
  assert.equal(adapter.provider, OPENCODE_HOST_PROVIDER);
  assert.equal(adapter.capabilities.spawn, true);
  assert.equal(adapter.capabilities.wait, true);
  assert.equal(adapter.capabilities.result, true);
  assert.equal(adapter.capabilities.inspect, true);
  assert.equal(adapter.capabilities.contain, true);
});

test('OpenCode host adapter transports a native task lifecycle without synthesizing results', async () => {
  let spawned = null;
  const adapter = createOpenCodeVisibleHostAdapter(nativeCapabilities({
    spawnTask: async input => {
      spawned = input;
      return { agentId: 'custom-opencode-worker-1', visibility: { mode: 'user-visible', surface: 'opencode-subagent', inspectRef: 'task:custom-opencode-worker-1' }, hostSpawnReceipt: { provider: OPENCODE_HOST_PROVIDER, dispatchId: input.dispatchId } };
    },
  }));

  const spawnedResult = await adapter.spawn({
    dispatchId: 'disp-1',
    packetDigest: 'a'.repeat(64),
    promptDigest: 'b'.repeat(64),
  });

  assert.equal(spawnedResult.agentId, 'custom-opencode-worker-1');
  assert.equal(spawnedResult.visibility.mode, 'user-visible');
  assert.equal(spawnedResult.visibility.surface, 'opencode-subagent');

  const inspected = await adapter.verifyVisibleLease({
    agentId: spawnedResult.agentId,
    dispatch: { dispatchId: 'disp-1', packetDigest: 'a'.repeat(64) },
    prompt: { promptDigest: 'b'.repeat(64) },
    runtimeReceipt: {
      visibility: spawnedResult.visibility,
      hostSpawnReceipt: spawnedResult.hostSpawnReceipt,
    },
  });
  assert.equal(inspected.verified, true);
  assert.equal(inspected.provider, OPENCODE_HOST_PROVIDER);

  const waited = await adapter.wait({ agentId: spawnedResult.agentId });
  assert.equal(waited.status, 'completed');

  const result = await adapter.result({ agentId: spawnedResult.agentId });
  assert.equal(result.result.status, 'completed');

  const contained = await adapter.contain({ agentId: spawnedResult.agentId });
  assert.equal(contained.contained, true);
});

test('OpenCode write guard blocks unauthorized file edits', async () => {
  const guard = createWriteGuard({
    getCurrentScope: async () => ({
      managed: true,
      workspaceRoot: process.cwd(),
      allowedPaths: ['src/allowed', 'docs/readme.md'],
    }),
  });

  // Allowed edit should not throw
  await assert.doesNotReject(async () => {
    await guard({ tool: 'edit' }, { args: { filePath: 'src/allowed/file.js' } });
  });

  // Disallowed edit should throw WRITE_BOUNDARY_VIOLATION
  await assert.rejects(
    async () => {
      await guard({ tool: 'write' }, { args: { filePath: 'forbidden/secret.txt' } });
    },
    error => error.code === 'WRITE_BOUNDARY_VIOLATION'
  );
});

test('OpenCode tools expose init, status and gate interfaces', () => {
  const tools = createOpenCodeTools({
    harness: {
      projectRegistry: {
        get: async () => ({ id: 'p1' }),
      },
      authorityStore: {
        activeRun: async () => null,
      },
    },
  });

  assert.equal(typeof tools.harness_init.execute, 'function');
  assert.deepEqual(tools.harness_init.parameters.required, ['decisionFile']);
  assert.equal(typeof tools.harness_status.execute, 'function');
  assert.equal(typeof tools.harness_gate.execute, 'function');
});

test('OpenCode plugin registers read-only/initialization commands without claiming a worker host', async () => {
  const plugin = await createOpenCodePlugin()({});
  assert.equal(typeof plugin.config, 'function');

  const cfg = {};
  plugin.config(cfg);

  assert.equal(typeof cfg.command?.h, 'object');
  assert.match(cfg.command.h.description, /Authority Decision/);
  assert.match(cfg.command.h.template, /harness_init/);
  assert.match(cfg.command.h.template, /unsupported/);

  assert.equal(typeof cfg.command?.['h:init'], 'object');
  assert.match(cfg.command['h:init'].description, /harness\.json/);
  assert.match(cfg.command['h:init'].template, /harness_init/);

  assert.equal(cfg.agent?.['harness-worker'], undefined);
});
