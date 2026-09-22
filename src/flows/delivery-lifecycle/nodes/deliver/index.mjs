import { deliveryNode } from '../node.mjs';

export const deliverNode = deliveryNode('deliver', 'deliver', 'delivery-receipt', ['review'], {
  readOnly: true,
  acceptance: ['Verify all required final gates, confirm finding ledger closure, and seal delivery receipt.'],
});

export const deliverNodes = [deliverNode];
