import { defineCommandManifest } from '../../platform/extensions/command-contract.mjs';
import { requirementsDesignWorkflow } from './graph/definition.mjs';

export const requirementsDesignCommands = defineCommandManifest({
  protocolVersion: '1.0', id: 'requirements-design-commands', profileId: 'composable-workflow', workflowId: requirementsDesignWorkflow.id,
  actions: { analyze: { targetKind: 'feature-key', presets: { default: { scope: 'requirements-and-design', stateChanging: true } } } },
});
