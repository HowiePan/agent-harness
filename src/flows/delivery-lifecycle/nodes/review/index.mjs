import { deliveryNode } from '../node.mjs';

export const reviewNode = deliveryNode('review', 'review', 'user-code-review', ['quality'], {
  readOnly: true,
  acceptance: ['Perform comprehensive user/reviewer code review before final delivery clearance.'],
});

export const reviewNodes = [reviewNode];
