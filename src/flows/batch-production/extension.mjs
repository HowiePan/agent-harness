import { defineExtensionPack } from '../../platform/extensions/contract.mjs';
import { collectionBatchProfile, batchProductionProfile } from './policy/index.mjs';
import { collectionWorkflowDefinition } from './graph/definition.mjs';
import { tabletopCollectionCommandManifest } from './commands.mjs';
import { createBatchProductionProjectDescriptor, compileBatchProductionFeatureGraph } from './descriptor.mjs';
import { createBatchProductionLifecyclePlan } from './planner.mjs';

export const extensionPack = defineExtensionPack({
  id: 'tabletop-collection-profile',
  aliases: ['batch-production-profile'],
  version: '1.0.0',
  profiles: [collectionBatchProfile, batchProductionProfile],
  workflows: [collectionWorkflowDefinition],
  commandManifest: tabletopCollectionCommandManifest,
  operationManifest: {
    createProjectDescriptor: { executionClass: 'pure-planner' },
    compileFeatureGraph: { executionClass: 'pure-planner' },
    createLifecyclePlan: { executionClass: 'pure-planner' },
  },
  operations: {
    createProjectDescriptor: createBatchProductionProjectDescriptor,
    compileFeatureGraph: compileBatchProductionFeatureGraph,
    createLifecyclePlan: createBatchProductionLifecyclePlan,
  },
});

export default extensionPack;
