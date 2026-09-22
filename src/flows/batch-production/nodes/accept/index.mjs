import { batchNode, batchTask } from '../node.mjs';

export const acceptNode = batchNode('accept', 'accept', ['review'], {
  readOnly: true,
  task: batchTask({
    role: { id: 'acceptance-controller', description: 'Checks final item acceptance conditions without substituting for user authority.' },
    objective: 'Determine whether the assigned item has all evidence and approvals required for final acceptance.',
    instructions: ['Consume the typed domain review.', 'Verify item acceptance criteria, required Decisions, Gates, and finding closure.', 'Do not infer user sign-off from an Agent conclusion.'],
    steps: [{ id: 'verify-acceptance', instruction: 'Verify every acceptance condition against current evidence.' }, { id: 'record-acceptance', instruction: 'Return the exact acceptance readiness state.' }],
    constraints: ['Remain read-only and require the configured authority for final sign-off.'],
    acceptance: ['Every acceptance criterion is satisfied with current evidence.', 'Required user authority and Gate receipts are present.', 'The batch-accept-v1 output sets accepted=true only when closure is valid.'],
  }),
});

export const acceptNodes = [acceptNode];
