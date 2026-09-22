import { deliveryNode, deliveryTask } from '../node.mjs';

export const deliverNode = deliveryNode('deliver', 'deliver', 'delivery-receipt', ['review'], {
  readOnly: true,
  task: deliveryTask({
    role: { id: 'delivery-controller', description: 'Verifies final authority, evidence, Gate, and finding closure before sealing delivery.' },
    objective: 'Produce the final delivery receipt only when every required closure condition is currently satisfied.',
    instructions: ['Consume the final typed review or quality result available on this route.', 'Verify required final Gates, Decisions, current-source quality evidence, and finding closure.', 'Return a blocking result instead of manufacturing clearance.'],
    steps: [{ id: 'verify-closure', instruction: 'Verify every configured delivery closure condition against current receipts.' }, { id: 'seal', instruction: 'Seal the final receipt only after all conditions pass.' }],
    constraints: ['Remain read-only and never substitute narrative approval for a Gate or Decision Receipt.'],
    acceptance: ['Every required final Gate and Decision is present and current.', 'No unresolved P0-P3 finding remains.', 'The delivery-receipt-v1 output identifies a valid closed delivery.'],
  }),
});

export const deliverNodes = [deliverNode];
