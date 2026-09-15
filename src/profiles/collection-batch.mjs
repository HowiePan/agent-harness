import { assert } from '../errors.mjs';
import { approvalSatisfied, orderedBarrier } from '../workflows/primitives.mjs';
import { createQualityFollowUpFeatures, hasCurrentCleanQualityReview } from './quality-loop.mjs';

export const collectionBatchProfile = Object.freeze({
  id: 'collection-batch',
  version: '1.0.0',

  validateConfig(config, features) {
    assert(config.activeBatch, 'ACTIVE_BATCH_REQUIRED', 'Collection Profile requires an active batch.');
    const batches = Array.isArray(config.batches) ? config.batches.map(batch => ({ id: String(batch.id), order: Number(batch.order), status: batch.status ?? 'planned' })) : [{ id: String(config.activeBatch), order: 1, status: 'active' }];
    assert(batches.some(batch => batch.id === config.activeBatch), 'ACTIVE_BATCH_UNKNOWN', 'The active batch must exist in the batch list.');
    const logicalGames = new Set(features.filter(feature => !feature.metadata.capabilityOwner).map(feature => feature.metadata.gameId).filter(Boolean));
    assert(logicalGames.size <= Number(config.maxLogicalGames ?? 10), 'LOGICAL_GAME_LIMIT_EXCEEDED', 'Collection batch exceeds its configured logical game limit.', { games: [...logicalGames] });
    return {
      activeBatch: String(config.activeBatch),
      batches,
      maxLogicalGames: Number(config.maxLogicalGames ?? 10),
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
    const owners = new Map();
    for (const feature of state.features) {
      assert(feature.metadata.batchId, 'FEATURE_BATCH_REQUIRED', `Collection Feature ${feature.id} requires metadata.batchId.`);
      assert(feature.metadata.gameId || feature.metadata.capabilityOwner, 'FEATURE_GAME_REQUIRED', `Collection Feature ${feature.id} requires metadata.gameId unless it is a declared shared-capability owner.`);
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
    const active = state.profile.config.batches.find(batch => batch.id === activeBatch);
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
    const games = [...new Set(state.features.filter(feature => !feature.metadata.capabilityOwner).map(feature => feature.metadata.gameId).filter(Boolean))];
    if (config.requireHarnessAcceptance) {
      const pendingGame = games.find(gameId => !approvalSatisfied(state, `game:${gameId}:harness-accepted`));
      if (pendingGame) return { ok: false, reason: `game-harness-acceptance-required:${pendingGame}` };
    }
    if (config.requireIndependentReview) {
      const pendingGame = games.find(gameId => !approvalSatisfied(state, `game:${gameId}:release-review-approved`));
      if (pendingGame) return { ok: false, reason: `game-release-review-required:${pendingGame}` };
    }
    if (config.requireUserGameAcceptance) {
      const pendingGame = games.find(gameId => !approvalSatisfied(state, `game:${gameId}:accepted`));
      if (pendingGame) return { ok: false, reason: `game-user-acceptance-required:${pendingGame}` };
    }
    const missingGate = state.profile.config.requiredFinalGates.find(id => !state.gates.some(gate => gate.id === id && gate.status === 'passed' && gate.forcedFresh));
    if (missingGate) return { ok: false, reason: `required-final-gate-missing:${missingGate}` };
    if (config.requireBatchCloseDecision && !approvalSatisfied(state, `batch:${batch}:closed`)) return { ok: false, reason: 'batch-close-decision-required' };
    return { ok: true };
  },

  project(state) {
    const games = {};
    for (const feature of state.features) {
      const gameId = feature.metadata.gameId ?? '_shared';
      games[gameId] ??= [];
      games[gameId].push({ id: feature.id, state: feature.state, blocker: feature.blocker ?? null });
    }
    return { profile: this.id, status: state.status, activeBatch: state.profile.config.activeBatch, epoch: state.epoch, generation: state.generation, games, openFindings: state.findings.filter(finding => finding.status !== 'resolved') };
  },
});
