import { assert } from '../../../../src/common/errors.mjs';

/**
 * Creates the chat participant handler for @harness in VS Code.
 */
export const createChatParticipantHandler = ({ getHarness, onProgress = null }) => {
  return async (request, context, response, token) => {
    const harness = typeof getHarness === 'function' ? await getHarness() : null;
    assert(harness, 'HARNESS_INSTANCE_UNAVAILABLE', 'Agent Harness is not initialized in VS Code extension.');

    const command = request.command;
    const prompt = (request.prompt ?? '').trim();

    response.progress(`Agent Harness: Handling ${command ? `/${command}` : 'request'}...`);

    if (command === 'status') {
      response.markdown(`### Agent Harness Active Status\n\n- Ready: True\n- Authority Root: \`${harness.dataRoot}\``);
      return { command: 'status', completed: true };
    }

    if (command === 'quality') {
      response.markdown(`### Quality Loop Initiated\n\nTarget: \`${prompt || 'active'}\`\n\nChecking gate readiness...`);
      return { command: 'quality', completed: true };
    }

    if (command === 'full') {
      response.markdown(`### Full Version Delivery Run\n\nPlan initialized for target: \`${prompt || 'V1'}\`.`);
      return { command: 'full', completed: true };
    }

    response.markdown(`**Agent Harness** received prompt: \`${prompt}\`\n\nAvailable commands: \`/full\`, \`/quality\`, \`/status\`.`);
    return { completed: true };
  };
};
