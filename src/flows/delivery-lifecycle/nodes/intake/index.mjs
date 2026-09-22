import { deliveryNode } from '../node.mjs';

export const intakeNode = deliveryNode('intake', 'requirements-intake', 'requirement-intake', [], {
  acceptance: ['Collect and normalize delivery requirements for the targeted release version.'],
});

export const canonicalNode = deliveryNode('canonical', 'canonical-requirement', 'canonical-requirement', ['intake'], {
  acceptance: ['Compile canonical requirement with exact scope boundaries and acceptance criteria.'],
});

export const intakeNodes = [intakeNode, canonicalNode];
