import { defineExtensionPack } from '../../platform/extensions/contract.mjs';
import { engineDeliveryProfile } from './policy/index.mjs';
import { engineWorkflowDefinition } from './graph/definition.mjs';
import { cardWorldCommandManifest } from './commands.mjs';
import { createCardWorldProjectDescriptor, compileCardWorldFeatureGraph } from './variants/cardworld/descriptor.mjs';
import { createCardWorldLifecyclePlan } from './planner.mjs';

export const extensionPack = defineExtensionPack({
  id: 'cardworld-engine-profile',
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
    createProjectDescriptor: createCardWorldProjectDescriptor,
    compileFeatureGraph: compileCardWorldFeatureGraph,
    createLifecyclePlan: createCardWorldLifecyclePlan,
  },
});

export default extensionPack;
