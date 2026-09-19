import { defineExtensionPack } from '../../platform/extensions/contract.mjs';
import { requirementsDesignWorkflow } from './graph/definition.mjs';
import { requirementsDesignCommands } from './commands.mjs';
import { createRequirementsDesignPlan } from './planner.mjs';

export const extensionPack = defineExtensionPack({
  id: 'requirements-design-workflow', version: '1.0.0', workflows: [requirementsDesignWorkflow], commandManifest: requirementsDesignCommands,
  operationManifest: { createLifecyclePlan: { executionClass: 'pure-planner' } }, operations: { createLifecyclePlan: createRequirementsDesignPlan },
});
export default extensionPack;
