import { readFileSync } from 'node:fs';
import { defineExtensionPack } from '../../platform/extensions/contract.mjs';
import { deliveryLifecycleProfile } from './policy/index.mjs';
import { deliveryLifecycleWorkflowDefinition } from './graph/definition.mjs';
import { deliveryLifecycleCommandManifest } from './commands.mjs';
import { createDeliveryProjectDescriptor, compileDeliveryFeatureGraph } from './descriptor.mjs';
import { createDeliveryLifecyclePlan } from './planner.mjs';

const projectInputSchema = JSON.parse(readFileSync(new URL('../../../schemas/delivery-project-input.schema.json', import.meta.url), 'utf8'));
const projectDescriptorInputSchema = JSON.parse(readFileSync(new URL('../../../schemas/project-descriptor-input.schema.json', import.meta.url), 'utf8'));

export const extensionPack = defineExtensionPack({
  id: 'delivery-lifecycle-profile',
  version: '1.0.0',
  profiles: [deliveryLifecycleProfile],
  workflows: [deliveryLifecycleWorkflowDefinition],
  commandManifest: deliveryLifecycleCommandManifest,
  planningCapabilities: ['quality-target'],
  projectConfiguration: {
    schema: projectInputSchema,
    schemas: { 'project-descriptor-input.schema.json': projectDescriptorInputSchema },
    example: { id: 'delivery-project', workspaceRoot: 'F:\\projects\\delivery', maxConcurrency: 'auto', gateRecipes: [] },
  },
  operationManifest: {
    createProjectDescriptor: { executionClass: 'pure-planner' },
    compileFeatureGraph: { executionClass: 'pure-planner' },
    createLifecyclePlan: { executionClass: 'pure-planner' },
  },
  operations: {
    createProjectDescriptor: createDeliveryProjectDescriptor,
    compileFeatureGraph: compileDeliveryFeatureGraph,
    createLifecyclePlan: createDeliveryLifecyclePlan,
  },
});

export default extensionPack;
