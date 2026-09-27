import { deliveryNode } from '../node.mjs';

export const closeoutNode = deliveryNode('closeout', 'closeout', 'quality-closeout', [], {
  readOnly: true,
  outputChecks: [{ portId: 'closeout', path: 'ready', operator: 'equals', value: true }],
  task: {
    role: { id: 'quality-closeout-verifier', description: 'Checks pinned prior quality evidence without performing another full review.' },
    objective: 'Confirm that the authoritative prior quality result and resolved Findings are ready for fresh final Gates.',
    instructions: ['Inspect the pinned quality target and current workspace identity.', 'Confirm every carried Finding is resolved with evidence.', 'Report a blocker if source or evidence has changed; do not claim that final Gates have passed.'],
    inputs: [{ id: 'target', source: 'intent', path: 'target', required: true, description: 'The version being closed.' }],
    steps: [{ id: 'inspect', instruction: 'Check the prior Run and Finding evidence pinned to this closeout.' }, { id: 'report', instruction: 'Report readiness or a precise blocker without modifying source.' }],
    constraints: ['Remain read-only.', 'Do not count this check as a full quality review.', 'Do not claim final Gate or version approval before Harness records them.'],
    acceptance: ['Prior quality evidence and current source identity are explicitly checked.', 'Every resolved Finding has authoritative resolution evidence.'],
    evidenceRequirements: ['Cite the pinned quality target and prior Run identity.'],
  },
});
