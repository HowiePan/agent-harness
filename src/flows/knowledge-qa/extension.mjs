import { defineExtensionPack } from '../../platform/extensions/contract.mjs';
import { knowledgeQaWorkflow } from './graph/definition.mjs';
import { knowledgeQaCommands } from './commands.mjs';
import { createKnowledgeQaPlan } from './planner.mjs';

export const extensionPack = defineExtensionPack({
  id: 'knowledge-qa-workflow', version: '1.0.0', workflows: [knowledgeQaWorkflow], commandManifest: knowledgeQaCommands,
  operationManifest: { createLifecyclePlan: { executionClass: 'pure-planner' } }, operations: { createLifecyclePlan: createKnowledgeQaPlan },
});
export default extensionPack;
