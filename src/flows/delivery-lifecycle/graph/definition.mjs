import { defineWorkflowDefinition } from '../../../platform/workflow/definition.mjs';

const engineNode = (id, action, stage, dependsOn = [], options = {}) => ({ id, template: 'engine-stage', action, stage, dependsOn, ...options });
export const engineWorkflowDefinition = defineWorkflowDefinition({
  id: 'engine-delivery', version: '1.0.0', profileId: 'engine-delivery',
  routes: {
    full: [
      engineNode('intake', 'requirements-intake', 'requirement-intake'),
      engineNode('canonical', 'canonical-requirement', 'canonical-requirement', ['intake']),
      engineNode('plan', 'plan', 'version-planning', ['canonical']),
      engineNode('implement', 'implement', 'implementation', ['plan']),
      engineNode('scope', 'scope', 'scope-resolution', ['implement']),
      engineNode('docs', 'docs', 'docs-closeout', ['scope']),
      engineNode('quality', 'quality', 'quality', ['docs'], { qualityReview: true }),
      engineNode('review', 'review', 'user-code-review', ['quality'], { readOnly: true }),
      engineNode('deliver', 'deliver', 'delivery-receipt', ['review'], { readOnly: true }),
    ],
    requirements: [engineNode('intake', 'requirements-intake', 'requirement-intake'), engineNode('canonical', 'canonical-requirement', 'canonical-requirement', ['intake']), engineNode('plan', 'plan', 'version-planning', ['canonical'])],
    deliver: [engineNode('quality', 'quality', 'quality', [], { qualityReview: true }), engineNode('deliver', 'deliver', 'delivery-receipt', ['quality'], { readOnly: true })],
    quality: [engineNode('quality', 'quality', 'quality', [], { qualityReview: true })],
    plan: [engineNode('plan', 'plan', 'version-planning')],
    implement: [engineNode('implement', 'implement', 'implementation')],
    scope: [engineNode('scope', 'scope', 'scope-resolution')],
    docs: [engineNode('docs', 'docs', 'docs-closeout')],
    review: [engineNode('review', 'review', 'user-code-review', [], { readOnly: true })],
  },
});
