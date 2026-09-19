import { defineExtensionPack } from '../../../src/platform/extensions/contract.mjs';
import { workflow } from './graph/definition.mjs';
import { commands } from './commands.mjs';
import { createPlan } from './planner.mjs';

export const extensionPack = defineExtensionPack({
  id: 'source-brief-workflow', version: '1.0.0', workflows: [workflow], commandManifest: commands,
  operationManifest: { createLifecyclePlan: { executionClass: 'pure-planner' } }, operations: { createLifecyclePlan: createPlan },
});
export default extensionPack;
