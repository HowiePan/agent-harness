import { assert } from '../../../common/errors.mjs';
import { approvalSatisfied, orderedBarrier } from '../../../flow-kit/primitives.mjs';
import { createQualityFollowUpFeatures, hasCurrentCleanQualityReview, validateQualityReviewPolicies } from '../../../flow-kit/profiles/quality-loop.mjs';

const resolveItemId = feature => feature.metadata.itemId ?? feature.metadata.gameId;

export const collectionBatchProfile = Object.freeze({
  id: 'collection-batch',
  version: '1.0.0',

  validateConfig(config, features) {
    assert(config.activeBatch, 'ACTIVE_BATCH_REQUIRED', 'Batch Profile requires an active batch.');
    const batches = Array.isArray(config.batches) ? config.batches.map(batch => ({ id: String(batch.id), order: Number(batch.order), status: batch.status ?? 'planned' })) : [{ id: String(config.activeBatch), order: 1, status: 'active' }];
    assert(batches.some(batch => batch.id === config.activeBatch), 'ACTIVE_BATCH_UNKNOWN', 'The active batch must exist in the batch list.');
    const maxItems = Number(config.maxLogicalItems ?? config.maxLogicalGames ?? 10);
    const logicalItems = new Set(features.filter(feature => !feature.metadata.capabilityOwner).map(resolveItemId).filter(Boolean));
    assert(logicalItems.size <= maxItems, 'LOGICAL_GAME_LIMIT_EXCEEDED', 'Batch exceeds its configured logical item limit.', { items: [...logicalItems], games: [...logicalItems] });
    return {
      activeBatch: String(config.activeBatch),
      batches,
      maxLogicalItems: maxItems,
      maxLogicalGames: maxItems,
      requiredFinalGates: [...new Set(config.requiredFinalGates ?? [])],
      requireRuleReady: config.requireRuleReady !== false,
      requireHarnessAcceptance: config.requireHarnessAcceptance !== false,
      requireIndependentReview: config.requireIndependentReview !== false,
      requireUserGameAcceptance: config.requireUserGameAcceptance !== false,
      requireBatchCloseDecision: config.requireBatchCloseDecision !== false,
      requireBatchLaunchDecision: config.requireBatchLaunchDecision !== false,
      requireFinalQualityReview: config.requireFinalQualityReview === true,
    };
  },

  createFollowUpFeatures(input) {
    return createQualityFollowUpFeatures(input);
  },

  validateRun(state) {
    validateQualityReviewPolicies(state.features);
    const owners = new Map();
    for (const feature of state.features) {
      assert(feature.metadata.batchId, 'FEATURE_BATCH_REQUIRED', `Batch Feature ${feature.id} requires metadata.batchId.`);
      const itemId = resolveItemId(feature);
      assert(itemId || feature.metadata.capabilityOwner, 'FEATURE_GAME_REQUIRED', `Batch Feature ${feature.id} requires metadata itemId/gameId unless it is a declared shared-capability owner.`);
      if (feature.metadata.capabilityKey && feature.metadata.capabilityOwner) {
        assert(!owners.has(feature.metadata.capabilityKey), 'CAPABILITY_OWNER_DUPLICATE', `Capability ${feature.metadata.capabilityKey} has multiple owners.`);
        owners.set(feature.metadata.capabilityKey, feature.id);
      }
    }
    for (const feature of state.features) {
      const consumed = feature.metadata.capabilityUses ?? (feature.metadata.capabilityKey && !feature.metadata.capabilityOwner ? [feature.metadata.capabilityKey] : []);
      for (const capabilityKey of consumed) {
        const owner = owners.get(capabilityKey);
        assert(owner && feature.dependsOn.includes(owner), 'CAPABILITY_OWNER_DEPENDENCY_REQUIRED', `Feature ${feature.id} must depend on the owner of ${capabilityKey}.`);
      }
    }
    return state;
  },

  canDispatch(feature, state) {
    const activeBatch = state.profile.config.activeBatch;
    if (feature.metadata.batchId !== activeBatch) return { ok: false, reason: 'batch-barrier' };
    if (!orderedBarrier({ currentId: activeBatch, entries: state.profile.config.batches }).ok) return { ok: false, reason: 'previous-batch-not-closed' };
    if (state.profile.config.requireBatchLaunchDecision && !approvalSatisfied(state, `batch:${activeBatch}:launched`)) return { ok: false, reason: 'batch-launch-decision-required' };
    if (state.profile.config.requireRuleReady && feature.metadata.ruleStatus !== 'rule-ready') return { ok: false, reason: 'rule-readiness-required' };
    return { ok: true };
  },

  canClose(state) {
    const batch = state.profile.config.activeBatch;
    const config = state.profile.config;
    if (config.requireFinalQualityReview) {
      const qualityRoots = [...new Set(state.features.filter(feature => feature.metadata?.qualityReview).map(feature => feature.metadata.qualityRoot))];
      const missingQualityRoot = qualityRoots.find(root => !hasCurrentCleanQualityReview(state, root));
      if (!qualityRoots.length || missingQualityRoot) return { ok: false, reason: `current-source-clean-quality-review-required${missingQualityRoot ? `:${missingQualityRoot}` : ''}` };
    }
    const items = [...new Set(state.features.filter(feature => !feature.metadata.capabilityOwner).map(resolveItemId).filter(Boolean))];
    if (config.requireHarnessAcceptance) {
      const pendingItem = items.find(itemId => !approvalSatisfied(state, `item:${itemId}:harness-accepted`) && !approvalSatisfied(state, `game:${itemId}:harness-accepted`));
      if (pendingItem) return { ok: false, reason: `game-harness-acceptance-required:${pendingItem}` };
    }
    if (config.requireIndependentReview) {
      const pendingItem = items.find(itemId => !approvalSatisfied(state, `item:${itemId}:release-review-approved`) && !approvalSatisfied(state, `game:${itemId}:release-review-approved`));
      if (pendingItem) return { ok: false, reason: `game-release-review-required:${pendingItem}` };
    }
    if (config.requireUserGameAcceptance) {
      const pendingItem = items.find(itemId => !approvalSatisfied(state, `item:${itemId}:accepted`) && !approvalSatisfied(state, `game:${itemId}:accepted`));
      if (pendingItem) return { ok: false, reason: `game-user-acceptance-required:${pendingItem}` };
    }
    const missingGate = state.profile.config.requiredFinalGates.find(id => !state.gates.some(gate => gate.id === id && gate.status === 'passed' && gate.forcedFresh));
    if (missingGate) return { ok: false, reason: `required-final-gate-missing:${missingGate}` };
    if (config.requireBatchCloseDecision && !approvalSatisfied(state, `batch:${batch}:closed`)) return { ok: false, reason: 'batch-close-decision-required' };
    return { ok: true };
  },

  project(state) {
    const items = {};
    for (const feature of state.features) {
      const itemId = resolveItemId(feature) ?? '_shared';
      items[itemId] ??= [];
      items[itemId].push({ id: feature.id, state: feature.state, blocker: feature.blocker ?? null });
    }
    return {
      profile: this.id,
      status: state.status,
      activeBatch: state.profile.config.activeBatch,
      epoch: state.epoch,
      generation: state.generation,
      items,
      games: items,
      openFindings: state.findings.filter(finding => finding.status !== 'resolved'),
    };
  },
});

export const batchProductionProfile = Object.freeze({
  ...collectionBatchProfile,
  id: 'batch-production',
});
