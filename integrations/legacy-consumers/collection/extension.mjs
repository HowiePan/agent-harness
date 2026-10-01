import { readFileSync } from 'node:fs';
import { defineExtensionPack } from '../../../src/platform/extensions/contract.mjs';
import { createBatchProductionWorkflowDefinition } from '../../../src/flows/batch-production/graph/definition.mjs';
import { createBatchProductionProfile } from '../../../src/flows/batch-production/policy/index.mjs';
import { createBatchProductionLifecyclePlanner } from '../../../src/flows/batch-production/planner.mjs';
import { createTabletopCollectionProjectDescriptor, compileTabletopCollectionFeatureGraph } from './variant/descriptor.mjs';
import { extendCollectionFeatures, collectionCapabilityFollowUps, collectionHandoffAllowed, collectionExhaustion } from './variant/shared-capabilities.mjs';
import { tabletopCollectionCommandManifest } from './commands.mjs';

const projectInputSchema = JSON.parse(readFileSync(new URL('../../../schemas/tabletop-collection-project-input.schema.json', import.meta.url), 'utf8'));
const deliveryProjectInputSchema = JSON.parse(readFileSync(new URL('../../../schemas/delivery-project-input.schema.json', import.meta.url), 'utf8'));

export const collectionWorkflowDefinition = createBatchProductionWorkflowDefinition({ id: 'collection-batch-production', profileId: 'collection-batch' });
const baseCollectionBatchProfile = createBatchProductionProfile({
  id: 'collection-batch',
  resolveItemId: feature => feature.metadata.itemId ?? feature.metadata.gameId,
  itemLabel: 'game',
  normalizeConfig: config => ({ ...config, requireUserItemAcceptance: config.requireUserItemAcceptance ?? config.requireUserGameAcceptance }),
  decisionKeys: (itemId, suffix) => [`item:${itemId}:${suffix}`, `game:${itemId}:${suffix}`],
  projectAliases: items => ({ games: items }),
});
export const collectionBatchProfile = Object.freeze({
  ...baseCollectionBatchProfile,
  createFollowUpFeatures(input) {
    return [...baseCollectionBatchProfile.createFollowUpFeatures(input), ...collectionCapabilityFollowUps(input)];
  },
  project(state) {
    return { ...baseCollectionBatchProfile.project(state), collectionExhaustion: collectionExhaustion(state) };
  },
  validateResult(input) {
    const { state, feature, result } = input;
    if (result.status === 'blocked' && feature.metadata?.stage === 'shared-capability'
      && result.failureClass === 'collection-shared-incomplete') {
      const value = result.outputs?.produce?.value;
      return { ok: Boolean(result.changedFiles?.length && Array.isArray(value?.collectionRemaining)
        && value.collectionRemaining.length && Array.isArray(result.outputs.produce.evidenceRefs)
        && result.outputs.produce.evidenceRefs.length), reason: 'shared-capability-progress-evidence-required' };
    }
    if (result.status === 'blocked' && feature.metadata?.stage === 'produce'
      && result.failureClass === 'collection-game-incomplete') {
      const value = result.outputs?.produce?.value;
      const audit = value?.scenarioAudit;
      return { ok: Boolean(result.changedFiles?.length && Array.isArray(value?.requiredScenarios) && value.requiredScenarios.length
        && Array.isArray(value.readyRemaining) && value.readyRemaining.length
        && Array.isArray(audit) && audit.length === value.requiredScenarios.length
        && new Set(audit.map(item => item.id)).size === value.requiredScenarios.length
        && value.readyRemaining.every(id => audit.some(item => item.id === id && item.disposition === 'blocked' && item.blockerKind === 'collection-game'))
        && audit.every(item => value.requiredScenarios.includes(item.id) && Array.isArray(item.evidenceRefs) && item.evidenceRefs.length)),
      reason: 'game-progress-audit-required' };
    }
    if (feature.metadata?.stage === 'shared-capability' && result.status === 'completed') {
      const value = result.outputs?.produce?.value;
      if (!Array.isArray(value?.collectionRemaining) || value.collectionRemaining.length) return { ok: false, reason: 'shared-capability-has-collection-work-remaining' };
      if (!Array.isArray(result.outputs.produce.evidenceRefs) || !result.outputs.produce.evidenceRefs.length) return { ok: false, reason: 'shared-capability-evidence-required' };
    }
    if (feature.metadata?.stage === 'produce' && result.status === 'completed') {
      const value = result.outputs?.produce?.value;
      const audit = value?.scenarioAudit;
      const inventory = value?.requiredScenarios;
      if (!Array.isArray(inventory) || !inventory.length || !Array.isArray(audit) || audit.length !== inventory.length
        || new Set(inventory).size !== inventory.length || new Set(audit.map(item => item.id)).size !== inventory.length
        || audit.some(item => !inventory.includes(item.id) || !['passed', 'blocked'].includes(item.disposition)
          || !Array.isArray(item.evidenceRefs) || !item.evidenceRefs.length)) return { ok: false, reason: 'completed-produce-requires-exhaustive-scenario-audit' };
      if (value.sharedCapabilityRequest) {
        const request = value.sharedCapabilityRequest;
        if (typeof request.key !== 'string' || typeof request.summary !== 'string' || !request.summary
          || !Array.isArray(request.scenarioIds) || !request.scenarioIds.length || new Set(request.scenarioIds).size !== request.scenarioIds.length
          || !Array.isArray(request.evidenceRefs) || !request.evidenceRefs.length || !Array.isArray(value.readyRemaining) || value.readyRemaining.length
          || !request.scenarioIds.every(id => audit.some(item => item.id === id && item.disposition === 'blocked' && item.blockerKind === 'collection-capability'))
          || audit.some(item => item.disposition === 'blocked' && !['collection-capability', 'engine-artifact'].includes(item.blockerKind))
          || !collectionHandoffAllowed({ state, feature, request })) return { ok: false, reason: 'collection-capability-handoff-invalid-or-exhausted' };
      } else if (audit.some(item => item.disposition === 'blocked')) return { ok: false, reason: 'completed-produce-has-blocked-scenarios' };
    }
    if (feature.metadata?.stage === 'produce' && result.status === 'blocked' && result.blocker?.kind === 'collection-capability') {
      const value = result.outputs?.produce?.value;
      const request = value?.sharedCapabilityRequest;
      if (!request || collectionHandoffAllowed({ state, feature, request }) || !Array.isArray(value.requiredScenarios)
        || !Array.isArray(value.readyRemaining) || value.readyRemaining.length
        || !Array.isArray(value.scenarioAudit) || value.scenarioAudit.length !== value.requiredScenarios.length
        || !Array.isArray(request.scenarioIds) || !request.scenarioIds.length || !Array.isArray(request.evidenceRefs) || !request.evidenceRefs.length
        || !request.scenarioIds.every(id => value.scenarioAudit.some(item => item.id === id && item.disposition === 'blocked' && item.blockerKind === 'collection-capability'))
        || value.scenarioAudit.some(item => !value.requiredScenarios.includes(item.id) || !Array.isArray(item.evidenceRefs) || !item.evidenceRefs.length))
        return { ok: false, reason: 'collection-capability-must-handoff-before-terminal-block' };
      return { ok: true };
    }
    return baseCollectionBatchProfile.validateResult(input);
  },
});
const baseCreateTabletopCollectionLifecyclePlan = createBatchProductionLifecyclePlanner({
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
  extendFeatures: extendCollectionFeatures,
});
export const createTabletopCollectionLifecyclePlan = input => {
  const plan = baseCreateTabletopCollectionLifecyclePlan(input);
  if (input.intent.action === 'produce' && plan.run.features.some(feature => feature.metadata.capabilityOwner)) {
    plan.run.profileConfig.requiredFinalGates = ['collection-produce-exhaustion-verify'];
    plan.stopCondition.requiredFinalGates = ['collection-produce-exhaustion-verify'];
  }
  return plan;
};

export const extensionPack = defineExtensionPack({
  id: 'tabletop-collection-profile',
  version: '1.0.0',
  profiles: [collectionBatchProfile],
  workflows: [collectionWorkflowDefinition],
  commandManifest: tabletopCollectionCommandManifest,
  planningCapabilities: ['quality-target', 'batch-release'],
  projectConfiguration: {
    schema: projectInputSchema,
    schemas: { 'delivery-project-input.schema.json': deliveryProjectInputSchema },
    example: { id: 'tabletop-collection', workspaceRoot: 'F:\\CardWorld\\tabletop-collection', maxConcurrency: 10, maxLogicalGames: 10, batches: [{ id: 'B1', ruleStatus: 'rule-ready', gameIds: ['example-game'] }] },
  },
  operationManifest: {
    createProjectDescriptor: { executionClass: 'pure-planner' },
    compileFeatureGraph: { executionClass: 'pure-planner' },
    createLifecyclePlan: { executionClass: 'pure-planner' },
    resolveQualityScopes: { executionClass: 'pure-planner' },
  },
  operations: {
    createProjectDescriptor: createTabletopCollectionProjectDescriptor,
    compileFeatureGraph: compileTabletopCollectionFeatureGraph,
    createLifecyclePlan: createTabletopCollectionLifecyclePlan,
    resolveQualityScopes: ({ project, target }) => (project.policy?.collectionBatches ?? []).find(batch => batch.id === target)?.gameIds?.map(gameId => ({ id: gameId, root: `collection:${target}:${gameId}` })) ?? [],
  },
});

export default extensionPack;
