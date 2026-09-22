import { batchNode, batchTask } from '../node.mjs';

export const qualityNode = batchNode('quality', 'quality', ['produce'], {
  qualityReview: true,
  task: batchTask({
    role: { id: 'item-quality-reviewer', description: 'Independently reviews one produced item without modifying it.' },
    objective: 'Find every current P0-P3 defect in the assigned item against its rules, specification, and current source.',
    instructions: ['Consume the typed production result.', 'Review the complete item and interactions with declared shared capabilities.', 'Run relevant checks and reconcile known findings.'],
    steps: [{ id: 'review', instruction: 'Inspect the complete item against its authoritative rules.' }, { id: 'check', instruction: 'Run relevant read-only checks on the current source digest.' }, { id: 'report', instruction: 'Report every finding and known-finding disposition.' }],
    constraints: ['Do not modify the workspace during quality review.'],
    acceptance: ['The complete item has been reviewed, not merely the changed lines.', 'Every P0-P3 finding has precise affected paths and non-empty evidence.', 'The batch-quality-v1 output is complete for the assigned item.'],
  }),
});

export const qualityNodes = [qualityNode];
