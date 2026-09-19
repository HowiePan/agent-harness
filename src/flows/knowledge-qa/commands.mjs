import { defineCommandManifest } from '../../platform/extensions/command-contract.mjs';
import { knowledgeQaWorkflow } from './graph/definition.mjs';

export const knowledgeQaCommands = defineCommandManifest({
  protocolVersion: '1.0', id: 'knowledge-qa-commands', profileId: 'composable-workflow', workflowId: knowledgeQaWorkflow.id,
  actions: { ask: { targetKind: 'question', presets: { default: { scope: 'answer-with-evidence', stateChanging: true } } } },
});
