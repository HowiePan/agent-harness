import { resolve } from 'node:path';
import { createProcessRuntime } from '../runtime/process-runtime.mjs';

export const manifest = Object.freeze({
  id: 'local-process-runtime',
  kind: 'agent-runtime',
  version: '1.0.0',
  capabilities: ['spawn', 'wait', 'send', 'heartbeat', 'interrupt', 'structured-result', 'managed-outputs', 'headless'],
  permissions: ['process.spawn'],
  execution: {
    outputs: [{ id: 'temporary', retention: 'ephemeral', environment: ['TEMP', 'TMP', 'TMPDIR'], maxBytes: 67_108_864, maxFiles: 10_000 }],
    sandbox: { mode: 'optional' },
  },
});

export const createPlugin = (config, context) => createProcessRuntime({
  ...config,
  manifest,
  controlRoot: context.controlRoot,
  temporaryRoot: config.temporaryRoot ?? resolve(context.dataRoot, 'runtime', manifest.id),
});
