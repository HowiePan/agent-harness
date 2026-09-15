import { createCallbackRuntime } from './callback-runtime.mjs';
import { createVisibleHostAdapter, isVisibleHostAdapter } from './visible-host-adapter.mjs';

export const CODEX_RUNTIME_MANIFEST = Object.freeze({
  id: 'codex-conversation-runtime',
  kind: 'agent-runtime',
  version: '1.0.0',
  capabilities: ['spawn', 'wait', 'send', 'heartbeat', 'interrupt', 'structured-result', 'user-visible', 'host-orchestrated', 'workspace-shared'],
  permissions: ['agent.conversation'],
});

const missingHostAdapter = () => {
  const unavailable = async () => {
    const error = new Error('Codex conversation Runtime requires the interactive host to create and monitor a visible child Agent.');
    error.code = 'VISIBLE_AGENT_HOST_REQUIRED';
    throw error;
  };
  return { spawn: unavailable, wait: unavailable, send: unavailable, heartbeat: unavailable, interrupt: unavailable };
};

export const createCodexVisibleHostAdapter = host => createVisibleHostAdapter({ ...host, provider: 'codex-host' });

export const createCodexRuntime = adapter => {
  const resolved = isVisibleHostAdapter(adapter)
    ? adapter
    : adapter?.inspectVisibleAgent
      ? createCodexVisibleHostAdapter(adapter)
      : adapter?.verifyVisibleLease || adapter?.heartbeatVisibleAgent
        ? (() => { throw Object.assign(new Error('Codex conversation Runtime requires a host adapter created by createCodexVisibleHostAdapter().'), { code: 'VISIBLE_AGENT_HOST_ADAPTER_REQUIRED' }); })()
        : adapter?.spawn
          ? adapter
          : missingHostAdapter();
  return createCallbackRuntime({ manifest: CODEX_RUNTIME_MANIFEST, adapter: resolved });
};
