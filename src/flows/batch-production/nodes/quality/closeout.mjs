import { batchNode, batchTask } from '../node.mjs';

export const closeoutNode = batchNode('closeout', 'closeout', [], {
  readOnly: true,
  outputChecks: [{ portId: 'closeout', path: 'ready', operator: 'equals', value: true }],
  task: batchTask({
    role: { id: 'item-quality-closeout-verifier', description: 'Checks pinned quality evidence for one batch item without another full review.' },
    objective: 'Verify that this item has resolved authoritative Findings on the current source before fresh final Gates.',
    instructions: ['Inspect the pinned quality target and prior Run.', 'Verify every carried Finding has resolution evidence.', 'Report exact blockers without modifying the workspace.'],
    steps: [{ id: 'inspect', instruction: 'Check the item-specific prior quality evidence and source identity.' }, { id: 'report', instruction: 'Report readiness or a precise blocker.' }],
    constraints: ['Remain read-only.', 'Do not count this check as a new full review or as batch acceptance.'],
    acceptance: ['Prior quality evidence binds this exact item and current source.', 'Every resolved Finding has authoritative evidence.'],
  }),
});
