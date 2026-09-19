import { CODEX_RUNTIME_MANIFEST as manifest, createCodexRuntime } from '../runtime/codex-runtime.mjs';

export { manifest };
export const createPlugin = (_config, context) => createCodexRuntime(context.adapter);

