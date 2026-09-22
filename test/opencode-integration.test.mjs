import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import {
  createOpenCodeVisibleHostAdapter,
  OPENCODE_HOST_PROVIDER,
} from '../integrations/opencode/src/adapter.mjs';
import { createWriteGuard } from '../integrations/opencode/src/guard.mjs';
import { createOpenCodeTools } from '../integrations/opencode/src/tools.mjs';
import { isVisibleHostAdapter } from '../src/platform/plugins/runtime/visible-host-adapter.mjs';

test('OpenCode host adapter conforms to VisibleHostAdapter contract', async () => {
  const adapter = createOpenCodeVisibleHostAdapter();
  assert.equal(isVisibleHostAdapter(adapter), true);
  assert.equal(adapter.provider, OPENCODE_HOST_PROVIDER);
  assert.equal(adapter.capabilities.spawn, true);
  assert.equal(adapter.capabilities.wait, true);
  assert.equal(adapter.capabilities.result, true);
  assert.equal(adapter.capabilities.inspect, true);
  assert.equal(adapter.capabilities.contain, true);
});

test('OpenCode host adapter executes full task lifecycle', async () => {
  let spawned = null;
  const adapter = createOpenCodeVisibleHostAdapter({
    spawnTask: async input => {
      spawned = input;
      return { agentId: 'custom-opencode-worker-1' };
    },
  });

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
      workspaceRoot: process.cwd(),
      allowedPaths: ['src/allowed', 'docs/readme.md'],
    }),
  });

  // Allowed edit should not throw
  await assert.doesNotReject(async () => {
    await guard({ tool: 'edit', args: { filePath: 'src/allowed/file.js' } });
  });

  // Disallowed edit should throw WRITE_BOUNDARY_VIOLATION
  await assert.rejects(
    async () => {
      await guard({ tool: 'write', args: { filePath: 'forbidden/secret.txt' } });
    },
    error => error.code === 'WRITE_BOUNDARY_VIOLATION'
  );
});

test('OpenCode tools expose status and gate interfaces', () => {
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

  assert.equal(typeof tools.harness_status.execute, 'function');
  assert.equal(typeof tools.harness_gate.execute, 'function');
});
