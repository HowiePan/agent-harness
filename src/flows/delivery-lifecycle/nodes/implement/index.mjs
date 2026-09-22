import { deliveryNode, deliveryTask } from '../node.mjs';

export const implementNode = deliveryNode('implement', 'implement', 'implementation', ['plan'], {
  task: deliveryTask({
    role: { id: 'implementation-engineer', description: 'Implements the approved delivery plan inside the exact authorized paths.' },
    objective: 'Implement the planned behavior for the selected target with minimal, verified changes.',
    instructions: ['Consume the typed delivery plan.', 'Inspect the current implementation before editing.', 'Implement only planned behavior and run focused checks after each material change.'],
    steps: [{ id: 'inspect', instruction: 'Inspect relevant source, contracts, tests, and generated assets.' }, { id: 'implement', instruction: 'Apply the smallest complete change within authorized paths.' }, { id: 'verify', instruction: 'Run focused checks and compare actual changes with the plan.' }],
    acceptance: ['Implemented behavior covers the planned Features without unauthorized scope.', 'Relevant focused checks pass or blocking evidence is returned.', 'The delivery-implementation-v1 output reports the exact changed files.'],
  }),
});

export const implementNodes = [implementNode];
