import { defineWorkflowDefinition } from '../../../platform/workflow/definition.mjs';
import { rulesNode } from '../nodes/rules/index.mjs';
import { produceNode } from '../nodes/produce/index.mjs';
import { qualityNode } from '../nodes/quality/index.mjs';
import { reviewNode } from '../nodes/review/index.mjs';
import { acceptNode } from '../nodes/accept/index.mjs';
import { launchNode, closeNode } from '../nodes/lifecycle/index.mjs';

const withDeps = (node, dependsOn) => ({ ...node, dependsOn });

export const collectionWorkflowDefinition = defineWorkflowDefinition({
  id: 'collection-batch-production',
  version: '1.0.0',
  profileId: 'collection-batch',
  routes: {
    full: [rulesNode, produceNode, qualityNode, reviewNode, acceptNode],
    rules: [rulesNode],
    launch: [launchNode],
    produce: [withDeps(produceNode, [])],
    quality: [withDeps(qualityNode, [])],
    review: [withDeps(reviewNode, [])],
    accept: [withDeps(acceptNode, [])],
    close: [closeNode],
  },
});
