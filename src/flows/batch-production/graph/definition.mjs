import { defineWorkflowDefinition } from '../../../platform/workflow/definition.mjs';
import { withDeps } from '../../../flow-kit/primitives.mjs';
import { rulesNode } from '../nodes/rules/index.mjs';
import { produceNode } from '../nodes/produce/index.mjs';
import { qualityNode } from '../nodes/quality/index.mjs';
import { reviewNode } from '../nodes/review/index.mjs';
import { acceptNode } from '../nodes/accept/index.mjs';
import { launchNode, closeNode } from '../nodes/lifecycle/index.mjs';
import { closeoutNode } from '../nodes/quality/closeout.mjs';
import { releasePrepareNode } from '../nodes/release/index.mjs';

export const createBatchProductionWorkflowDefinition = ({ id = 'batch-production', profileId = 'batch-production' } = {}) => defineWorkflowDefinition({
  id,
  version: '1.0.0',
  profileId,
  routes: {
    full: [rulesNode, produceNode, qualityNode, reviewNode, acceptNode],
    rules: [rulesNode],
    launch: [launchNode],
    produce: [withDeps(produceNode, [])],
    quality: [withDeps(qualityNode, [])],
    closeout: [closeoutNode],
    review: [withDeps(reviewNode, [])],
    accept: [withDeps(acceptNode, [])],
    close: [closeNode],
    prerelease: [releasePrepareNode],
  },
});

export const batchProductionWorkflowDefinition = createBatchProductionWorkflowDefinition();
