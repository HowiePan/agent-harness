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
        cfg.command ??= {};
        cfg.command['h'] = {
          description: 'Route and execute an Agent Harness workflow action, or initialize workspace with "init [actor]".',
          template: [
            'Examine the requested Agent Harness argument: "$ARGUMENTS".',
            '1. If $ARGUMENTS starts with "init":',
            '   Call the `harness_init` tool with actor extracted from arguments (if empty, default to "howie") and file="harness.json". Report the registration result.',
            '2. Otherwise:',
            '   Execute the requested workflow action:',
            '   - Resolve target project and workflow intent.',
            '   - Query `harness_status` to ensure no conflicting active Run is running.',
            '   - Coordinate execution through `harness-worker` following strict quality criteria.',
            '   - Execute `harness_gate` before closing the lifecycle run.',
          ].join('\n'),
        };

        cfg.command['h:init'] = {
          description: 'Initialize and register Agent Harness workspace from local harness.json.',
          template: [
            'Initialize and register the Agent Harness workspace for this project.',
            'Call the `harness_init` tool with actor="$ARGUMENTS" (if empty, default to "howie") and file="harness.json".',
            'Report the registration status, workspaceId, alias, revision, and configured sources and projects.',
          ].join('\n'),
        };

        cfg.command['h-init'] = cfg.command['h:init'];

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
