import { defineExtensionPack } from '../../platform/extensions/contract.mjs';
import { engineDeliveryProfile } from './policy/index.mjs';
import { engineWorkflowDefinition } from './graph/definition.mjs';
import { cardWorldCommandManifest } from './commands.mjs';
import { createDeliveryProjectDescriptor, compileDeliveryFeatureGraph } from './descriptor.mjs';
import { createDeliveryLifecyclePlan } from './planner.mjs';

export const extensionPack = defineExtensionPack({
  id: 'cardworld-engine-profile',
  aliases: ['engine-delivery-profile', 'delivery-lifecycle-profile'],
  version: '1.0.0',
  profiles: [engineDeliveryProfile],
  workflows: [engineWorkflowDefinition],
  commandManifest: cardWorldCommandManifest,
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
