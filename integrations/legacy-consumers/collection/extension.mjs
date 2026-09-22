import { readFileSync } from 'node:fs';
import { defineExtensionPack } from '../../../src/platform/extensions/contract.mjs';
import { createBatchProductionWorkflowDefinition } from '../../../src/flows/batch-production/graph/definition.mjs';
import { createBatchProductionProfile } from '../../../src/flows/batch-production/policy/index.mjs';
import { createBatchProductionLifecyclePlanner } from '../../../src/flows/batch-production/planner.mjs';
import { createTabletopCollectionProjectDescriptor, compileTabletopCollectionFeatureGraph } from './variant/descriptor.mjs';
import { tabletopCollectionCommandManifest } from './commands.mjs';

const projectInputSchema = JSON.parse(readFileSync(new URL('../../../schemas/tabletop-collection-project-input.schema.json', import.meta.url), 'utf8'));
const deliveryProjectInputSchema = JSON.parse(readFileSync(new URL('../../../schemas/delivery-project-input.schema.json', import.meta.url), 'utf8'));

export const collectionWorkflowDefinition = createBatchProductionWorkflowDefinition({ id: 'collection-batch-production', profileId: 'collection-batch' });
export const collectionBatchProfile = createBatchProductionProfile({
  id: 'collection-batch',
  resolveItemId: feature => feature.metadata.itemId ?? feature.metadata.gameId,
  itemLabel: 'game',
  normalizeConfig: config => ({ ...config, requireUserItemAcceptance: config.requireUserItemAcceptance ?? config.requireUserGameAcceptance }),
  decisionKeys: (itemId, suffix) => [`item:${itemId}:${suffix}`, `game:${itemId}:${suffix}`],
  projectAliases: items => ({ games: items }),
});
export const createTabletopCollectionLifecyclePlan = createBatchProductionLifecyclePlanner({
  workflowDefinition: collectionWorkflowDefinition,
  profileId: 'collection-batch',
  profileConfigKeys: ['collection-batch'],
  resolveBatches: project => project.policy?.collectionBatches ?? project.policy?.batches ?? [],
  resolveItems: batch => batch?.gameIds ?? batch?.itemIds ?? batch?.items,
  defaultItemKey: 'gameId',
  defaultConflictPrefix: 'game',
  defaultQualityRootPrefix: 'collection',
  extendProfileConfig: ({ requireUserItemAcceptance }) => ({ requireUserGameAcceptance: requireUserItemAcceptance }),
  selectorErrorCode: 'COLLECTION_GAME_NOT_IN_BATCH',
});

export const extensionPack = defineExtensionPack({
  id: 'tabletop-collection-profile',
  version: '1.0.0',
  profiles: [collectionBatchProfile],
  workflows: [collectionWorkflowDefinition],
  commandManifest: tabletopCollectionCommandManifest,
  projectConfiguration: {
    schema: projectInputSchema,
    schemas: { 'delivery-project-input.schema.json': deliveryProjectInputSchema },
    example: { id: 'tabletop-collection', workspaceRoot: 'F:\\CardWorld\\tabletop-collection', maxConcurrency: 10, maxLogicalGames: 10, batches: [{ id: 'B1', ruleStatus: 'rule-ready', gameIds: ['example-game'] }] },
  },
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
