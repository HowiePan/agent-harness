import { batchNode } from '../node.mjs';

export const launchNode = batchNode('launch', 'launch', [], {
  readOnly: true,
  acceptance: ['Verify environment and prerequisite readiness before launching batch execution.'],
});

export const closeNode = batchNode('close', 'close', [], {
  readOnly: true,
  acceptance: ['Verify all batch items and shared capabilities are accepted before closing batch.'],
});

export const lifecycleNodes = [launchNode, closeNode];
