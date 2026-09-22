/** Build delivery Features from an explicitly installed business variant. */
export const createDeliveryTemplates = ({ actionPaths, forbiddenPaths = ['.git', '.agent-harness-data'], qualityRootPrefix = 'delivery' } = {}) => {
  const safeForbidden = [...new Set(['.git', '.agent-harness-data', ...(forbiddenPaths ?? []).filter(p => !p.includes(':') && !p.startsWith('/'))])];
  const makeFeature = ({ action, target, stage, dependsOn = [], allowedPaths = [], sourcePolicy = 'write', qualityFindingPolicy = 'repair-and-rereview', ownerRole = 'operator', qualityReview = false, sourceDigest, knownFindingInventory = null }) => ({
    id: `${action}/${target}`,
    executionClass: 'agent-reasoning', kind: action, ownerRole,
    logicalRoot: `${action}:${target}`, laneId: qualityReview ? 'quality' : action,
    acceptance: qualityReview
      ? [`Perform a complete read-only review of ${target} against authoritative version documents and the current workspace source digest.`, 'Run relevant focused checks and cite non-empty evidence for every P0-P3 finding.', 'Return an exact structured result; do not modify the workspace during review.']
      : [`Complete the declared ${action} scope for ${target}.`, 'Return structured evidence and an exact changedFiles list.'],
    steps: qualityReview
      ? [{ id: 'review', title: `Review ${target} completely without workspace writes.` }, { id: 'report', title: 'Report every P0-P3 finding and supporting evidence.' }]
      : [{ id: 'execute', title: `Execute ${action} for ${target}.` }],
    dependsOn, allowedPaths: qualityReview ? [] : [...allowedPaths], forbiddenPaths: [...safeForbidden],
    conflictKeys: [`${target}-${qualityReview ? 'quality-review' : action}`], gatePlan: [],
    metadata: { stage, sourcePolicy, target, version: target, allowDynamicDecomposition: !qualityReview && allowedPaths.length > 0,
      ...(qualityReview ? { qualityReview: true, qualityFindingPolicy, qualityRoot: `${qualityRootPrefix}:${target}`, reviewRound: 1, reviewSourceDigest: sourceDigest, ...(knownFindingInventory ? { knownFindingInventory: structuredClone(knownFindingInventory) } : {}), qualityContext: { target, version: target, ...(knownFindingInventory ? { knownFindingInventory: structuredClone(knownFindingInventory) } : {}) } } : {}),
    },
  });

  const stageTemplate = ({ context, node, dependsOn }) => {
    const readOnly = node.readOnly || context.intent.sourcePolicy === 'read-only' || node.qualityReview;
    const pathsSource = context.intent?.actionPaths ?? context.project?.policy?.actionPaths ?? actionPaths ?? {};
    const pathsForAction = node.action === 'requirements-intake' || node.action === 'canonical-requirement' ? pathsSource.requirements : pathsSource[node.action];
    const resolvedPaths = Array.isArray(pathsForAction) ? pathsForAction : [];
    return makeFeature({ action: node.action, target: context.intent.target, stage: node.stage, dependsOn,
      allowedPaths: readOnly ? [] : resolvedPaths, sourcePolicy: readOnly ? 'read-only' : 'write',
      ownerRole: node.qualityReview || node.action === 'review' ? 'reviewer' : 'operator', qualityReview: Boolean(node.qualityReview),
      qualityFindingPolicy: context.intent.sourcePolicy === 'read-only' ? 'record-only' : 'repair-and-rereview', sourceDigest: context.sourceDigest, knownFindingInventory: context.intent.knownFindingInventory ?? null });
  };

  return {
    'delivery-stage': stageTemplate,
  };
};
