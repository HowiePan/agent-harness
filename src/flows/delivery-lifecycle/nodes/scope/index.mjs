import { deliveryNode } from '../node.mjs';

export const scopeNode = deliveryNode('scope', 'scope', 'scope-resolution', ['implement'], {
  acceptance: ['Resolve scope boundaries, path authorizations, and work breakdown conflicts.'],
});

export const scopeNodes = [scopeNode];
