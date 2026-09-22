import { deliveryNode } from '../node.mjs';

export const qualityNode = deliveryNode('quality', 'quality', 'quality', ['docs'], {
  qualityReview: true,
  acceptance: [
    'Perform complete read-only review against authoritative version documents and workspace state.',
    'Run relevant focused checks and cite non-empty evidence for every P0-P3 finding.',
    'Do not modify the workspace during review.',
  ],
});

export const qualityNodes = [qualityNode];
