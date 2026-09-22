import { batchNode } from '../node.mjs';

export const rulesNode = batchNode('rules', 'rules', [], {
  acceptance: ['Verify and confirm readiness of business and domain rules for the targeted batch item.'],
});

export const rulesNodes = [rulesNode];
