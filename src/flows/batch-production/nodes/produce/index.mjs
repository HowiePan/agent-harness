import { batchNode, batchTask } from '../node.mjs';

export const produceNode = batchNode('produce', 'produce', ['rules'], {
  task: batchTask({
    role: { id: 'item-producer', description: 'Produces one batch item from its verified rule contract.' },
    objective: 'Implement the assigned item completely within its authorized paths and verified rules.',
    instructions: ['Consume the typed rule-readiness result.', 'Inspect the current item state before editing.', 'Implement the complete item and run focused verification.'],
    steps: [{ id: 'inspect', instruction: 'Inspect the item specification, current source, and shared capabilities.' }, { id: 'produce', instruction: 'Implement the smallest complete item change.' }, { id: 'verify', instruction: 'Run focused checks and account for every changed file.' }],
    acceptance: ['The item conforms to every verified rule and declared specification.', 'No other item or shared capability is modified without authorization.', 'The batch-produce-v1 output reports the exact changed files.'],
  }),
});

export const produceNodes = [produceNode];
