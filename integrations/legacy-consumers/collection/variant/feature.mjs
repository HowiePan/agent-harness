import { createBatchFeatureFactory } from '../../../../src/flows/batch-production/nodes/batch/feature.mjs';

export const createCollectionFeature = ({ intent, batch, gateIds, sourceDigest }) => {
  const makeItemFeature = createBatchFeatureFactory({
    intent,
    batch,
    gateIds,
    sourceDigest,
    itemKey: 'gameId',
    conflictPrefix: 'game',
    qualityRootPrefix: 'collection',
    itemPaths: gameId => [`games/presets/${gameId}`, 'packages', 'apps', 'docs'],
    forbiddenPaths: ['.git', '.agent-harness-data', 'runs'],
  });
  return ({ gameId, ...options }) => makeItemFeature({ itemId: gameId, ...options });
};
