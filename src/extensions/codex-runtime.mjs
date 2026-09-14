import { defineExtensionPack } from './contract.mjs';
import { CODEX_CLI_RUNTIME_MANIFEST, CODEX_ISOLATED_RUNTIME_MANIFEST, createCodexCliRuntime } from '../plugins/runtime/codex-cli-runtime.mjs';
import { CODEX_RUNTIME_MANIFEST, createCodexRuntime } from '../plugins/runtime/codex-runtime.mjs';
import { createIsolatedWorkspaceProvider } from '../plugins/runtime/isolated-workspace.mjs';

export const extensionPack = defineExtensionPack({
  id: 'codex-runtime',
  version: '1.0.0',
  plugins: [
    {
      manifest: CODEX_RUNTIME_MANIFEST,
      create: ({ agentAdapter }) => createCodexRuntime(agentAdapter),
    },
    {
      manifest: CODEX_CLI_RUNTIME_MANIFEST,
      create: ({ resolveProject, dataRoot, controlRoot }) => createCodexCliRuntime({
        resolveProject,
        runtimeRoot: dataRoot,
        controlRoot,
        manifest: CODEX_CLI_RUNTIME_MANIFEST,
      }),
    },
    {
      manifest: CODEX_ISOLATED_RUNTIME_MANIFEST,
      create: ({ resolveProject, dataRoot, controlRoot }) => createCodexCliRuntime({
        resolveProject,
        runtimeRoot: dataRoot,
        controlRoot,
        manifest: CODEX_ISOLATED_RUNTIME_MANIFEST,
        workspaceProvider: createIsolatedWorkspaceProvider({ manifestId: CODEX_ISOLATED_RUNTIME_MANIFEST.id, controlRoot }),
      }),
    },
  ],
});

export default extensionPack;
