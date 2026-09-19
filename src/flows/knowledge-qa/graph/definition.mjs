import { defineWorkflowDefinition } from '../../../platform/workflow/definition.mjs';
import { questionNodes } from '../nodes/question/index.mjs';
import { memoryNodes } from '../nodes/memory/index.mjs';
import { discoveryNodes } from '../nodes/discovery/index.mjs';
import { answerNodes, clarificationNodes } from '../nodes/response/index.mjs';

export const knowledgeQaWorkflow = defineWorkflowDefinition({
  id: 'knowledge-qa', version: '1.0.0', profileId: 'composable-workflow',
  routes: { ask: [...questionNodes, ...memoryNodes], search: discoveryNodes, answer: answerNodes, clarify: clarificationNodes },
});
