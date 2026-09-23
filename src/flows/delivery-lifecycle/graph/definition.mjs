import { defineWorkflowDefinition } from '../../../platform/workflow/definition.mjs';
import { withDeps } from '../../../flow-kit/primitives.mjs';
import { intakeNode, canonicalNode } from '../nodes/intake/index.mjs';
import { expansionNode } from '../nodes/expansion/index.mjs';
import { planNode } from '../nodes/plan/index.mjs';
import { implementNode } from '../nodes/implement/index.mjs';
import { scopeNode } from '../nodes/scope/index.mjs';
import { docsNode } from '../nodes/docs/index.mjs';
import { qualityNode } from '../nodes/quality/index.mjs';
import { reviewNode } from '../nodes/review/index.mjs';
import { deliverNode } from '../nodes/deliver/index.mjs';

export const createDeliveryWorkflowDefinition = ({ id = 'delivery-lifecycle', profileId = 'delivery-lifecycle' } = {}) => defineWorkflowDefinition({
  id,
  version: '1.0.0',
  profileId,
  routes: {
    full: [
      intakeNode,
      expansionNode,
      canonicalNode,
      planNode,
      implementNode,
      scopeNode,
      docsNode,
      qualityNode,
      reviewNode,
      deliverNode,
    ],
    requirements: [intakeNode, expansionNode, canonicalNode],
    'expand-to-plan': [intakeNode, expansionNode, canonicalNode, planNode],
    direct: [withDeps(intakeNode, []), withDeps(canonicalNode, ['intake']), withDeps(planNode, ['canonical'])],
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
