import { defineWorkflowDefinition } from '../../../platform/workflow/definition.mjs';
import { withDeps } from '../../../flow-kit/primitives.mjs';
import { intakeNode, canonicalNode } from '../nodes/intake/index.mjs';
import { expansionNode } from '../nodes/expansion/index.mjs';
import { planNode, planReviewNode } from '../nodes/plan/index.mjs';
import { implementNode } from '../nodes/implement/index.mjs';
import { scopeNode } from '../nodes/scope/index.mjs';
import { docsNode } from '../nodes/docs/index.mjs';
import { qualityNode } from '../nodes/quality/index.mjs';
import { closeoutNode } from '../nodes/quality/closeout.mjs';
import { reviewNode } from '../nodes/review/index.mjs';
import { deliverNode } from '../nodes/deliver/index.mjs';
import { releasePrepareNode, releaseDocsNode } from '../nodes/prerelease/index.mjs';

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
      planReviewNode,
      implementNode,
      scopeNode,
      docsNode,
      qualityNode,
      reviewNode,
      deliverNode,
    ],
    requirements: [intakeNode, expansionNode, canonicalNode],
    'expand-to-plan': [intakeNode, expansionNode, canonicalNode, planNode, planReviewNode],
    direct: [withDeps(intakeNode, []), withDeps(canonicalNode, ['intake']), withDeps(planNode, ['canonical']), planReviewNode],
    deliver: [withDeps(qualityNode, []), withDeps(deliverNode, ['quality'])],
    prerelease: [releasePrepareNode, releaseDocsNode],
    quality: [withDeps(qualityNode, [])],
    closeout: [closeoutNode],
    plan: [withDeps(planNode, []), planReviewNode],
    replan: [withDeps(planNode, []), planReviewNode],
    implement: [withDeps(implementNode, []), scopeNode, docsNode, qualityNode],
    scope: [withDeps(scopeNode, [])],
    docs: [withDeps(docsNode, [])],
    review: [withDeps(reviewNode, [])],
  },
});

export const deliveryLifecycleWorkflowDefinition = createDeliveryWorkflowDefinition();
