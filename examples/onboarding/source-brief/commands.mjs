import { defineCommandManifest } from '../../../src/platform/extensions/command-contract.mjs';
import { workflow } from './graph/definition.mjs';

export const commands = defineCommandManifest({
  protocolVersion: '1.0', id: 'source-brief-commands', profileId: 'composable-workflow', workflowId: workflow.id,
  actions: { summarize: { targetKind: 'feature-key', presets: { default: { scope: 'source-brief', stateChanging: true } } } },
});
