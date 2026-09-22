import { createOpenCodeTools } from './tools.mjs';
import { createWriteGuard } from './guard.mjs';
import { createOpenCodeVisibleHostAdapter, OPENCODE_HOST_PROVIDER } from './adapter.mjs';

/**
 * OpenCode Plugin definition conforming to `Plugin = (input: PluginInput, options?) => Promise<Hooks>`.
 */
export const createOpenCodePlugin = (options = {}) => {
  return async ({ client, project, directory, $ } = {}) => {
    let harness = options.harness ?? null;
    const tools = createOpenCodeTools({
      harness,
      getHarness: async () => harness,
    });

    const writeGuard = createWriteGuard({
      getCurrentScope: options.getCurrentScope ?? (async () => null),
    });

    return {
      tool: tools,
      'tool.execute.before': writeGuard,
      config: cfg => {
        cfg.command ??= {};
        cfg.command['h'] = {
          description: 'Inspect Agent Harness state and initialize a project or Workspace with an external Authority Decision. Lifecycle execution is unsupported in this channel.',
          template: [
            'Examine the requested Agent Harness argument: "$ARGUMENTS".',
            '1. If $ARGUMENTS starts with "init <decision-file>":',
            '   Call the `harness_init` tool with file="harness.json", projectRoot set to the current project, and decisionFile set to the explicit decision file. Never create or infer an approval.',
            '2. Otherwise:',
            '   Query `harness_status` only, then report that OpenCode conversation-visible lifecycle execution is unsupported until a verified native host contract is installed.',
          ].join('\n'),
        };

        cfg.command['h:init'] = {
          description: 'Initialize and register Agent Harness from project-owned harness.json.',
          template: [
            'Initialize and register the Agent Harness workspace for this project.',
            'Require an explicit Authority Decision file in $ARGUMENTS. Call `harness_init` with decisionFile="$ARGUMENTS", file="harness.json", and projectRoot set to the current project. Never create or infer an approval.',
            'Report the initialization receipt, project or workspace identity, alias, and revision.',
          ].join('\n'),
        };

        cfg.command['h-init'] = cfg.command['h:init'];

      },
    };
  };
};

export { createOpenCodeVisibleHostAdapter, OPENCODE_HOST_PROVIDER } from './adapter.mjs';
export { createOpenCodeTools } from './tools.mjs';
export { createWriteGuard } from './guard.mjs';

export default createOpenCodePlugin();
