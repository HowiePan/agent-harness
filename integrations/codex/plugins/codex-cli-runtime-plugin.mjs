import { CODEX_CLI_RUNTIME_MANIFEST as manifest, createCodexCliRuntime } from '../runtime/codex-cli-runtime.mjs';

export { manifest };
export const createPlugin = (config, context) => createCodexCliRuntime({ ...config, manifest, resolveProject: context.resolveProject, runtimeRoot: context.dataRoot, controlRoot: context.controlRoot });
