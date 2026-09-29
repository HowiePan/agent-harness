import { assert } from '../../common/errors.mjs';
import { normalizeQualityReviewLimit } from './quality-budget.mjs';
import { assertQualityRepairInventorySnapshot } from '../../platform/execution/quality-target.mjs';

/** Shared, Authority-bound planning rules for quality actions. Flow planners own routes and closure policy. */
export const prepareQualityPlanning = ({ intent, project, sourceDigest, profileConfigKeys, actions = ['implement', 'quality', 'full', 'deliver'], majorReleasePreset = 'release-exhaustive',
  missingTargetMessage = 'Quality planning requires an Authority-derived Quality Target snapshot.',
  missingInventoryMessage = 'Quality planning requires an Authority-derived quality inventory snapshot.' }) => {
  assert(intent.qualityTarget, 'QUALITY_TARGET_SNAPSHOT_REQUIRED', missingTargetMessage);
  const repairOnly = intent.action === 'quality' && intent.preset === 'repair-known';
  const closeoutOnly = intent.action === 'quality' && (intent.preset === 'closeout' || repairOnly && intent.qualityRepairInventory?.findings.length === 0);
  const exhaustive = intent.action === 'quality' && intent.preset === majorReleasePreset;
  if (actions.includes(intent.action) && !repairOnly && !closeoutOnly) assert(intent.knownFindingInventory, 'QUALITY_INVENTORY_SNAPSHOT_REQUIRED', missingInventoryMessage);
  if (repairOnly) {
    const inventory = assertQualityRepairInventorySnapshot(intent.qualityRepairInventory);
    assert(inventory.targetDigest === intent.qualityTarget.targetDigest && inventory.sourceDigest === sourceDigest, 'QUALITY_REPAIR_INVENTORY_BINDING_MISMATCH', 'Repair inventory must bind the current Authority target and source.');
  }
  if (closeoutOnly) assert(intent.qualityCloseout?.targetDigest === intent.qualityTarget.targetDigest && intent.qualityCloseout.sourceDigest === sourceDigest, 'QUALITY_CLOSEOUT_SNAPSHOT_REQUIRED', 'Independent closeout requires current authoritative evidence.');
  assert(!exhaustive || (project.policy?.majorReleaseTargets ?? []).includes(intent.target), 'QUALITY_EXHAUSTIVE_MAJOR_RELEASE_REQUIRED', 'Unbounded exhaustive review requires an explicitly declared major release target.');
  const configuredLimit = normalizeQualityReviewLimit(project.policy?.qualityReviewLimit ?? Object.assign({}, ...profileConfigKeys.map(key => project.policy?.profileConfigs?.[key] ?? {})).qualityReviewLimit);
  if (actions.includes(intent.action) && !repairOnly && !closeoutOnly) assert(configuredLimit.mode !== 'unbounded' || exhaustive, 'QUALITY_UNBOUNDED_MODE_DENIED', 'Unbounded quality review is available only to the explicit major-release exhaustive preset.');
  const qualityReviewLimit = exhaustive ? { mode: 'unbounded' } : configuredLimit;
  const priorQualityReviews = intent.qualityTarget.reviewHistory?.length ?? 0;
  if (!repairOnly && !closeoutOnly && actions.includes(intent.action)) assert(qualityReviewLimit.mode === 'unbounded' || priorQualityReviews < 1 + qualityReviewLimit.maxRechecks, 'QUALITY_REVIEW_LIMIT_REACHED', 'The target has exhausted its configured quality review budget.');
  return { repairOnly, closeoutOnly, exhaustive, qualityReviewLimit, priorQualityReviews };
};

export const prepareScopedQualityPlanning = ({ intent, project, sourceDigest, scopeIds, actions = ['quality', 'full'] }) => {
  assert(Array.isArray(scopeIds) && scopeIds.length > 0 && new Set(scopeIds).size === scopeIds.length, 'QUALITY_SCOPES_INVALID', 'Quality planning requires unique scope IDs.');
  const qualityReviewLimit = normalizeQualityReviewLimit(project.policy?.qualityReviewLimit);
  assert(qualityReviewLimit.mode === 'bounded', 'QUALITY_UNBOUNDED_MODE_DENIED', 'Scoped quality review requires a bounded limit.');
  const repairOnly = intent.action === 'quality' && intent.preset === 'repair-known';
  const closeoutOnly = intent.action === 'quality' && (intent.preset === 'closeout' || repairOnly && scopeIds.every(id => intent.qualityRepairInventories?.[id]?.findings.length === 0));
  const priorQualityReviews = {};
  const findingIds = new Set();
  for (const id of scopeIds) {
    const target = intent.qualityTargets?.[id];
    assert(target?.scopeRoot && target.sourceDigest === sourceDigest, 'QUALITY_TARGET_SNAPSHOT_REQUIRED', `Quality scope ${id} requires an Authority-derived current-source target.`);
    priorQualityReviews[target.scopeRoot] = target.reviewHistory?.length ?? 0;
    if (actions.includes(intent.action) && !repairOnly && !closeoutOnly) {
      assert(intent.knownFindingInventories?.[id]?.targetDigest === target.targetDigest, 'QUALITY_INVENTORY_SNAPSHOT_REQUIRED', `Quality scope ${id} requires an Authority-derived inventory.`);
      assert(priorQualityReviews[target.scopeRoot] < 1 + qualityReviewLimit.maxRechecks, 'QUALITY_REVIEW_LIMIT_REACHED', `Quality scope ${id} has exhausted its review budget.`);
    }
    if (repairOnly) {
      const inventory = assertQualityRepairInventorySnapshot(intent.qualityRepairInventories?.[id]);
      assert(inventory.targetDigest === target.targetDigest && inventory.sourceDigest === sourceDigest, 'QUALITY_REPAIR_INVENTORY_BINDING_MISMATCH', `Repair inventory for ${id} differs from Authority.`);
      for (const finding of inventory.findings) {
        assert(!findingIds.has(finding.id), 'QUALITY_SCOPED_FINDING_DUPLICATE', `Finding ${finding.id} belongs to multiple quality scopes.`);
        findingIds.add(finding.id);
      }
    }
    if (closeoutOnly) assert(intent.qualityCloseouts?.[id]?.targetDigest === target.targetDigest, 'QUALITY_CLOSEOUT_SNAPSHOT_REQUIRED', `Quality scope ${id} requires pinned closeout evidence.`);
  }
  return { repairOnly, closeoutOnly, qualityReviewLimit, priorQualityReviews };
};
