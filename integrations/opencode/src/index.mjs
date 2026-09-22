import { createOpenCodeTools } from './tools.mjs';
import { createWriteGuard } from './guard.mjs';
import { createOpenCodeVisibleHostAdapter, OPENCODE_HOST_PROVIDER } from './adapter.mjs';

/**
 * OpenCode Plugin definition conforming to `Plugin = (input: PluginInput, options?) => Promise<Hooks>`.
 */
export const createOpenCodePlugin = (options = {}) => {
  return async ({ client, project, directory, $ } = {}) => {
    let harness = options.harness ?? null;
    let currentScope = null;

    const tools = createOpenCodeTools({
      harness,
      getHarness: async () => harness,
    });

    const writeGuard = createWriteGuard({
      getCurrentScope: async () => currentScope,
    });

    return {
      tool: tools,
      'tool.execute.before': writeGuard,
      config: cfg => {
        cfg.agent ??= {};
        cfg.agent['harness-worker'] ??= {
          description: 'Autonomous worker agent executing dispatched Agent Harness tasks.',
          mode: 'subagent',
          permission: { edit: 'allow', bash: 'ask' },
        };
      },
    };
  };
};

export { createOpenCodeVisibleHostAdapter, OPENCODE_HOST_PROVIDER } from './adapter.mjs';
export { createOpenCodeTools } from './tools.mjs';
export { createWriteGuard } from './guard.mjs';

export default createOpenCodePlugin();
