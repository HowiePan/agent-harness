import { assert } from '../../../../src/common/errors.mjs';

/**
 * Creates the chat participant handler for @harness in VS Code.
 */
export const createChatParticipantHandler = ({ getHarness, initializeProject = null }) => {
  return async (request, context, response, token) => {
    const harness = typeof getHarness === 'function' ? await getHarness() : null;
    const command = request.command;
    const prompt = (request.prompt ?? '').trim();

    response.progress(`Agent Harness: Handling ${command ? `/${command}` : 'request'}...`);

    if (command === 'init') {
      assert(typeof initializeProject === 'function', 'HARNESS_INITIALIZER_UNAVAILABLE', 'Agent Harness initializer is unavailable in VS Code.');
      assert(prompt, 'VSCODE_INIT_DECISION_REQUIRED', 'Use /init with the path to an external Authority Decision JSON file.');
      const result = await initializeProject({ decisionPath: prompt });
      response.markdown(`### Agent Harness initialized\n\n- Project: \`${result.projectId}\`\n- Alias: \`${result.alias}\`\n- Receipt: \`${result.receipt.receiptDigest}\``);
      return { command: 'init', completed: true, projectId: result.projectId };
    }

    if (command === 'status') {
      assert(harness, 'HARNESS_INSTANCE_UNAVAILABLE', 'Agent Harness is not initialized in VS Code extension.');
      response.markdown(`### Agent Harness Active Status\n\n- Ready: True\n- Authority Root: \`${harness.dataRoot}\``);
      return { command: 'status', completed: true };
    }

    if (command === 'quality') {
      response.markdown('### Unsupported host capability\n\nVS Code conversation-visible lifecycle execution is disabled until a verified native spawn/inspect/wait/result/contain contract is available. No Run was created.');
      return { command: 'quality', completed: false, status: 'unsupported' };
    }

    if (command === 'full') {
      response.markdown('### Unsupported host capability\n\nVS Code conversation-visible lifecycle execution is disabled until a verified native spawn/inspect/wait/result/contain contract is available. No Run was created.');
      return { command: 'full', completed: false, status: 'unsupported' };
    }

    response.markdown(`**Agent Harness** received prompt: \`${prompt}\`\n\nAvailable commands: \`/init\`, \`/full\`, \`/quality\`, \`/status\`.`);
    return { completed: true };
  };
};
