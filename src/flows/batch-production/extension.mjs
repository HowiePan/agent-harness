import { defineExtensionPack } from '../../platform/extensions/contract.mjs';
import { collectionBatchProfile } from './policy/index.mjs';
import { collectionWorkflowDefinition } from './graph/definition.mjs';
import { tabletopCollectionCommandManifest } from './commands.mjs';
import { createTabletopCollectionProjectDescriptor, compileTabletopCollectionFeatureGraph } from './variants/collection/descriptor.mjs';
import { createTabletopCollectionLifecyclePlan } from './planner.mjs';

export const extensionPack = defineExtensionPack({
  id: 'tabletop-collection-profile',
  version: '1.0.0',
  profiles: [collectionBatchProfile],
  workflows: [collectionWorkflowDefinition],
  commandManifest: tabletopCollectionCommandManifest,
  operationManifest: {
    createProjectDescriptor: { executionClass: 'pure-planner' },
    compileFeatureGraph: { executionClass: 'pure-planner' },
    createLifecyclePlan: { executionClass: 'pure-planner' },
  },
  operations: {
    createProjectDescriptor: createTabletopCollectionProjectDescriptor,
    compileFeatureGraph: compileTabletopCollectionFeatureGraph,
    createLifecyclePlan: createTabletopCollectionLifecyclePlan,
  },
});

export default extensionPack;
