/** Build batch item Features from an installed business variant. */
export const createBatchFeatureFactory = ({ intent, batch, gateIds, sourceDigest, itemKey, itemPaths, forbiddenPaths, conflictPrefix, qualityRootPrefix }) =>
  ({ action, itemId, dependsOn = [], readOnly = false, qualityReview = false }) => {
    const ruleStatus = batch.ruleStatus ?? 'rule-ready';
    const knownFindingInventory = intent.knownFindingInventories?.[itemId] ?? null;
    const qualityCloseout = intent.qualityCloseouts?.[itemId] ?? null;
    return {
      id: `${action}/${intent.target}/${itemId}`,
      executionClass: 'agent-reasoning', kind: action,
      ownerRole: qualityReview || action === 'review' ? 'reviewer' : action === 'accept' ? 'user-acceptance' : 'operator',
      logicalRoot: `${action}:${intent.target}:${itemId}`, laneId: itemId,
      acceptance: qualityReview
        ? [`Perform a complete read-only quality review for ${itemId} in batch ${intent.target}.`, 'Cite non-empty evidence for every P0-P3 finding and return an exact structured result.']
        : [`Complete ${action} for ${itemId} in batch ${intent.target}.`, 'Return structured evidence and an exact changedFiles list.'],
      steps: qualityReview ? [{ id: 'review', title: `Review ${itemId} without workspace writes.` }, { id: 'report', title: 'Report all P0-P3 findings.' }] : [{ id: 'execute', title: `Execute ${action} for ${itemId}.` }],
      dependsOn,
      allowedPaths: readOnly || qualityReview ? [] : itemPaths(itemId),
      forbiddenPaths: [...forbiddenPaths],
      conflictKeys: [`${conflictPrefix}:${itemId}`, `${action}:${intent.target}:${itemId}`], gatePlan: gateIds,
      metadata: { scope: intent.scope, sourcePolicy: qualityReview || readOnly ? 'read-only' : 'write', stage: action,
        batchId: intent.target, itemId, [itemKey]: itemId, ruleStatus,
        ...(qualityReview ? { qualityReview: true, qualityFindingPolicy: intent.sourcePolicy === 'read-only' ? 'record-only' : 'repair-and-rereview', qualityRoot: `${qualityRootPrefix}:${intent.target}:${itemId}`, reviewRound: 1, reviewSourceDigest: sourceDigest,
          ...(knownFindingInventory ? { knownFindingInventory: structuredClone(knownFindingInventory) } : {}),
          qualityContext: { batchId: intent.target, [itemKey]: itemId, ruleStatus, ...(knownFindingInventory ? { knownFindingInventory: structuredClone(knownFindingInventory) } : {}) } } : {}),
        ...(action === 'closeout' && qualityCloseout ? { qualityRoot: `${qualityRootPrefix}:${intent.target}:${itemId}`, qualityCloseout: structuredClone(qualityCloseout) } : {}),
        ...(action === 'release-prepare' && intent.batchClearance ? { batchClearance: structuredClone(intent.batchClearance) } : {}),
      },
    };
  };
