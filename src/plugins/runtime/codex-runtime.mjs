import { createCallbackRuntime } from './callback-runtime.mjs';

export const CODEX_RUNTIME_MANIFEST = Object.freeze({
  id: 'codex-conversation-runtime',
  kind: 'agent-runtime',
  version: '1.0.0',
  capabilities: ['spawn', 'wait', 'send', 'heartbeat', 'interrupt', 'structured-result'],
  permissions: ['agent.conversation'],
});

export const createCodexRuntime = adapter => createCallbackRuntime({ manifest: CODEX_RUNTIME_MANIFEST, adapter });
