import { readFileSync } from 'node:fs';
import { defineExtensionPack } from '../../platform/extensions/contract.mjs';
import { batchProductionProfile } from './policy/index.mjs';
import { batchProductionWorkflowDefinition } from './graph/definition.mjs';
import { batchProductionCommandManifest } from './commands.mjs';
import { createBatchProductionProjectDescriptor, compileBatchProductionFeatureGraph } from './descriptor.mjs';
import { createBatchProductionLifecyclePlan } from './planner.mjs';

const projectInputSchema = JSON.parse(readFileSync(new URL('../../../schemas/batch-production-project-input.schema.json', import.meta.url), 'utf8'));
const deliveryProjectInputSchema = JSON.parse(readFileSync(new URL('../../../schemas/delivery-project-input.schema.json', import.meta.url), 'utf8'));
const projectDescriptorInputSchema = JSON.parse(readFileSync(new URL('../../../schemas/project-descriptor-input.schema.json', import.meta.url), 'utf8'));

export const extensionPack = defineExtensionPack({
  id: 'batch-production-profile',
  version: '1.0.0',
  profiles: [batchProductionProfile],
  workflows: [batchProductionWorkflowDefinition],
  commandManifest: batchProductionCommandManifest,
  projectConfiguration: {
    schema: projectInputSchema,
    schemas: { 'delivery-project-input.schema.json': deliveryProjectInputSchema, 'project-descriptor-input.schema.json': projectDescriptorInputSchema },
    example: { id: 'batch-project', workspaceRoot: 'F:\\projects\\batch', maxConcurrency: 10, maxLogicalItems: 10, batches: [] },
  },
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
