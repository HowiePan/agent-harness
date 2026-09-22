import { batchNode } from '../node.mjs';

export const qualityNode = batchNode('quality', 'quality', ['produce'], {
  qualityReview: true,
  acceptance: [
    'Perform complete read-only quality review for the target item in this batch.',
    'Cite non-empty evidence for every P0-P3 finding and return an exact structured result.',
  ],
});

export const qualityNodes = [qualityNode];
