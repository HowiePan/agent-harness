import { readFileSync } from 'node:fs';
import { defineExtensionPack } from '../../../src/platform/extensions/contract.mjs';
import { createDeliveryWorkflowDefinition } from '../../../src/flows/delivery-lifecycle/graph/definition.mjs';
import { createDeliveryLifecycleProfile } from '../../../src/flows/delivery-lifecycle/policy/index.mjs';
import { createDeliveryCommandManifest } from '../../../src/flows/delivery-lifecycle/commands.mjs';
import { createDeliveryLifecyclePlanner } from '../../../src/flows/delivery-lifecycle/planner.mjs';
import { createCardWorldProjectDescriptor, compileCardWorldFeatureGraph } from './variant/descriptor.mjs';

const projectInputSchema = JSON.parse(readFileSync(new URL('../../../schemas/cardworld-project-input.schema.json', import.meta.url), 'utf8'));
const projectDescriptorInputSchema = JSON.parse(readFileSync(new URL('../../../schemas/project-descriptor-input.schema.json', import.meta.url), 'utf8'));

export const engineWorkflowDefinition = createDeliveryWorkflowDefinition({ id: 'engine-delivery', profileId: 'engine-delivery' });
export const engineDeliveryProfile = createDeliveryLifecycleProfile('engine-delivery');
export const cardWorldCommandManifest = createDeliveryCommandManifest({ id: 'engine-delivery-commands', profileId: 'engine-delivery', workflowId: 'engine-delivery' });
export const createCardWorldLifecyclePlan = createDeliveryLifecyclePlanner({
  workflowDefinition: engineWorkflowDefinition,
  profileId: 'engine-delivery',
  profileConfigKeys: ['engine-delivery'],
  qualityRootPrefix: 'engine',
  stopConditionPrefix: 'engine',
});

export const extensionPack = defineExtensionPack({
  id: 'cardworld-engine-profile',
  version: '1.0.0',
  profiles: [engineDeliveryProfile],
  workflows: [engineWorkflowDefinition],
  commandManifest: cardWorldCommandManifest,
  planningCapabilities: ['quality-target'],
  projectConfiguration: {
    schema: projectInputSchema,
    schemas: { 'project-descriptor-input.schema.json': projectDescriptorInputSchema },
    example: { id: 'cardworld-engine', workspaceRoot: 'F:\\CardWorld', remote: 'https://github.com/HowiePan/CardWorld.git', maxConcurrency: 1 },
  },
  operationManifest: {
    createProjectDescriptor: { executionClass: 'pure-planner' },
    compileFeatureGraph: { executionClass: 'pure-planner' },
    createLifecyclePlan: { executionClass: 'pure-planner' },
  },
  operations: {
    createProjectDescriptor: createCardWorldProjectDescriptor,
    compileFeatureGraph: compileCardWorldFeatureGraph,
    createLifecyclePlan: createCardWorldLifecyclePlan,
  },
});

export default extensionPack;
