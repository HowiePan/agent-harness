import { CODEX_ISOLATED_RUNTIME_MANIFEST as manifest, createCodexCliRuntime } from '../runtime/codex-cli-runtime.mjs';
import { createIsolatedWorkspaceProvider } from '../runtime/isolated-workspace.mjs';

export { manifest };
export const createPlugin = (config, context) => createCodexCliRuntime({
  ...config,
  manifest,
  resolveProject: context.resolveProject,
  runtimeRoot: context.dataRoot,
  controlRoot: context.controlRoot,
  workspaceProvider: createIsolatedWorkspaceProvider({ manifestId: manifest.id, controlRoot: context.controlRoot }),
});
