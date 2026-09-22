import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createVSCodeVisibleHostAdapter,
  VSCODE_HOST_PROVIDER,
  activateWithVSCode,
  deactivate,
  createChatParticipantHandler,
  RunTreeProvider,
  LedgerTreeProvider,
} from '../integrations/vscode/src/extension.mjs';
import { isVisibleHostAdapter } from '../src/platform/plugins/runtime/visible-host-adapter.mjs';

const nativeCapabilities = (overrides = {}) => ({
  spawnTask: async input => ({ agentId: 'vscode-native-1', visibility: { mode: 'user-visible', surface: 'vscode-chat', inspectRef: 'task:vscode-native-1' }, hostSpawnReceipt: { provider: VSCODE_HOST_PROVIDER, dispatchId: input.dispatchId } }),
  inspectTask: async input => ({ verified: true, status: 'running', assertionId: 'vscode-native-observation', observedAt: new Date().toISOString(), agentId: input.agentId, dispatchId: input.dispatchId, packetDigest: input.packetDigest, promptDigest: input.promptDigest, visibility: { mode: 'user-visible', surface: input.surface, inspectRef: input.inspectRef } }),
  waitTask: async () => ({ status: 'completed', progress: '100%' }),
  resultTask: async () => ({ result: { status: 'completed', summary: 'native result', changedFiles: [] }, receipt: { provider: VSCODE_HOST_PROVIDER } }),
  cancelTask: async () => ({ contained: true, provider: VSCODE_HOST_PROVIDER }),
  reconcileHostEffects: async () => ({ reconciled: true, ready: true, provider: VSCODE_HOST_PROVIDER }),
  confirmLease: async () => ({ confirmed: true, provider: VSCODE_HOST_PROVIDER }),
  ...overrides,
});

test('VS Code host adapter fails closed without every native capability', () => {
  assert.throws(() => createVSCodeVisibleHostAdapter(), error => error.code === 'VSCODE_VISIBLE_HOST_CAPABILITIES_REQUIRED');
});

test('VS Code host adapter conforms only with a complete native contract', async () => {
  const adapter = createVSCodeVisibleHostAdapter(nativeCapabilities());
  assert.equal(isVisibleHostAdapter(adapter), true);
  assert.equal(adapter.provider, VSCODE_HOST_PROVIDER);
  assert.equal(adapter.capabilities.spawn, true);
  assert.equal(adapter.capabilities.wait, true);
  assert.equal(adapter.capabilities.result, true);
  assert.equal(adapter.capabilities.inspect, true);
  assert.equal(adapter.capabilities.contain, true);
});

test('VS Code host adapter transports a native task lifecycle without synthesizing results', async () => {
  let spawned = null;
  const adapter = createVSCodeVisibleHostAdapter(nativeCapabilities({
    spawnTask: async input => {
      spawned = input;
      return { agentId: 'custom-vscode-agent-1', visibility: { mode: 'user-visible', surface: 'vscode-chat', inspectRef: 'task:custom-vscode-agent-1' }, hostSpawnReceipt: { provider: VSCODE_HOST_PROVIDER, dispatchId: input.dispatchId } };
    },
  }));

  const spawnedResult = await adapter.spawn({
    dispatchId: 'disp-vs-1',
    packetDigest: 'c'.repeat(64),
    promptDigest: 'd'.repeat(64),
  });

  assert.equal(spawnedResult.agentId, 'custom-vscode-agent-1');
  assert.equal(spawnedResult.visibility.mode, 'user-visible');
  assert.equal(spawnedResult.visibility.surface, 'vscode-chat');

  const inspected = await adapter.verifyVisibleLease({
    agentId: spawnedResult.agentId,
    dispatch: { dispatchId: 'disp-vs-1', packetDigest: 'c'.repeat(64) },
    prompt: { promptDigest: 'd'.repeat(64) },
    runtimeReceipt: {
      visibility: spawnedResult.visibility,
      hostSpawnReceipt: spawnedResult.hostSpawnReceipt,
    },
  });
  assert.equal(inspected.verified, true);
  assert.equal(inspected.provider, VSCODE_HOST_PROVIDER);

  const waited = await adapter.wait({ agentId: spawnedResult.agentId });
  assert.equal(waited.status, 'completed');

  const result = await adapter.result({ agentId: spawnedResult.agentId });
  assert.equal(result.result.status, 'completed');

  const contained = await adapter.contain({ agentId: spawnedResult.agentId });
  assert.equal(contained.contained, true);
});

test('VS Code Chat Participant handles commands', async () => {
  const responses = [];
  const mockResponse = {
    progress: msg => responses.push({ type: 'progress', msg }),
    markdown: md => responses.push({ type: 'markdown', md }),
  };

  const handler = createChatParticipantHandler({
    getHarness: async () => ({ dataRoot: '/tmp/harness-data' }),
  });

  const statusResult = await handler({ command: 'status', prompt: '' }, {}, mockResponse, {});
  assert.equal(statusResult.completed, true);
  assert.equal(responses.some(r => r.md?.includes('Authority Root')), true);

  const qualityResult = await handler({ command: 'quality', prompt: 'v1.0' }, {}, mockResponse, {});
  assert.equal(qualityResult.completed, false);
  assert.equal(qualityResult.status, 'unsupported');
  assert.equal(responses.some(r => r.md?.includes('No Run was created')), true);
});

test('VS Code Tree Providers return items', async () => {
  const runProvider = new RunTreeProvider({
    getHarness: async () => ({ status: 'ready' }),
  });
  const rootItems = await runProvider.getChildren(null);
  assert.equal(rootItems.length, 1);
  assert.equal(rootItems[0].id, 'unsupported');

  const ledgerProvider = new LedgerTreeProvider({
    getHarness: async () => ({ status: 'ready' }),
  });
  const ledgerRoots = await ledgerProvider.getChildren(null);
  assert.equal(ledgerRoots.length, 1);
  assert.equal(ledgerRoots[0].id, 'unsupported');
});

test('VS Code extension activates and registers contributions', async () => {
  const subscriptions = [];
  const registered = {
    commands: [],
    views: [],
    participants: [],
  };

  const mockVscode = {
    chat: {
      createChatParticipant: (id, handler) => {
        registered.participants.push({ id, handler });
        return { dispose: () => {} };
      },
    },
    window: {
      registerTreeDataProvider: (viewId, provider) => {
        registered.views.push({ viewId, provider });
        return { dispose: () => {} };
      },
    },
    commands: {
      registerCommand: (cmd, callback) => {
        registered.commands.push({ cmd, callback });
        return { dispose: () => {} };
      },
    },
  };

  const context = { subscriptions };

  const api = await activateWithVSCode(context, mockVscode);
  assert.equal(typeof api.setHarness, 'function');
  assert.equal(typeof api.initializeProject, 'function');
  assert.equal(registered.participants.length, 1);
  assert.equal(registered.views.length, 2);
  assert.equal(registered.commands.length, 2);
  assert(registered.commands.some(item => item.cmd === 'agent-harness.initializeProject'));
  assert.equal(api.lifecycleExecutionSupported, false);

  deactivate();
});
