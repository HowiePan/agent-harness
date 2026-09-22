import { defineWorkflowDefinition } from '../../../platform/workflow/definition.mjs';
import { intakeNode, canonicalNode } from '../nodes/intake/index.mjs';
import { planNode } from '../nodes/plan/index.mjs';
import { implementNode } from '../nodes/implement/index.mjs';
import { scopeNode } from '../nodes/scope/index.mjs';
import { docsNode } from '../nodes/docs/index.mjs';
import { qualityNode } from '../nodes/quality/index.mjs';
import { reviewNode } from '../nodes/review/index.mjs';
import { deliverNode } from '../nodes/deliver/index.mjs';

const withDeps = (node, dependsOn) => ({ ...node, dependsOn });

export const createDeliveryWorkflowDefinition = ({ id = 'delivery-lifecycle', profileId = 'delivery-lifecycle' } = {}) => defineWorkflowDefinition({
  id,
  version: '1.0.0',
  profileId,
  routes: {
    full: [
      intakeNode,
      canonicalNode,
      planNode,
      implementNode,
      scopeNode,
      docsNode,
      qualityNode,
      reviewNode,
      deliverNode,
    ],
    requirements: [intakeNode, canonicalNode, planNode],
    deliver: [withDeps(qualityNode, []), withDeps(deliverNode, ['quality'])],
    quality: [withDeps(qualityNode, [])],
    plan: [withDeps(planNode, [])],
    implement: [withDeps(implementNode, [])],
    scope: [withDeps(scopeNode, [])],
    docs: [withDeps(docsNode, [])],
    review: [withDeps(reviewNode, [])],
  },
});

export const deliveryLifecycleWorkflowDefinition = createDeliveryWorkflowDefinition();
