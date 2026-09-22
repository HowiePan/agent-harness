import { deliveryNode } from '../node.mjs';

export const docsNode = deliveryNode('docs', 'docs', 'docs-closeout', ['scope'], {
  acceptance: ['Update release notes, integration guides, and documentation matching verified changes.'],
});

export const docsNodes = [docsNode];
