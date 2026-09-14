import { createCallbackRuntime } from './callback-runtime.mjs';

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

export const createCodexRuntime = adapter => createCallbackRuntime({ manifest: CODEX_RUNTIME_MANIFEST, adapter: adapter ?? missingHostAdapter() });
