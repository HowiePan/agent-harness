import { batchNode } from '../node.mjs';

export const reviewNode = batchNode('review', 'review', ['quality'], {
  readOnly: true,
  acceptance: ['Perform comprehensive domain review and verification for the target batch item.'],
});

export const reviewNodes = [reviewNode];
