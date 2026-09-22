import { batchNode } from '../node.mjs';

export const acceptNode = batchNode('accept', 'accept', ['review'], {
  readOnly: true,
  acceptance: ['Verify item acceptance criteria and obtain final sign-off for the targeted batch item.'],
});

export const acceptNodes = [acceptNode];
