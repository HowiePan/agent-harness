import { defineExtensionPack } from '../../../src/platform/extensions/contract.mjs';
import { CODEX_RUNTIME_MANIFEST, createCodexRuntime } from '../runtime/codex-runtime.mjs';

export { CODEX_RUNTIME_MANIFEST, createCodexRuntime, createCodexVisibleHostAdapter } from '../runtime/codex-runtime.mjs';

export const extensionPack = defineExtensionPack({
  id: 'codex-runtime',
  version: '1.0.0',
  plugins: [
    {
      manifest: CODEX_RUNTIME_MANIFEST,
      create: ({ agentAdapter }) => createCodexRuntime(agentAdapter),
    },
  ],
});

export default extensionPack;
