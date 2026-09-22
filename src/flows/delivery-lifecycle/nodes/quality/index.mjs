import { deliveryNode, deliveryTask } from '../node.mjs';

export const qualityNode = deliveryNode('quality', 'quality', 'quality', ['docs'], {
  qualityReview: true,
  task: deliveryTask({
    role: { id: 'quality-reviewer', description: 'Independently reviews the complete target without modifying the workspace.' },
    objective: 'Determine whether the current target satisfies its authoritative requirements and identify every current P0-P3 defect.',
    instructions: ['Review the complete current source state against authoritative requirements and typed upstream results.', 'Run relevant focused checks.', 'Reconcile every known finding and report all new findings with precise evidence.'],
    steps: [{ id: 'review', instruction: 'Inspect the full requirement, implementation, documentation, and applicable contracts.' }, { id: 'check', instruction: 'Run relevant read-only checks against the current source digest.' }, { id: 'report', instruction: 'Report every P0-P3 finding and every known-finding disposition.' }],
    constraints: ['Do not modify the workspace during quality review.', 'Do not downgrade or omit a finding because it existed previously.'],
    acceptance: ['The complete target has been reviewed against the current source digest.', 'Every P0-P3 finding has non-empty evidence and precise affected paths.', 'The delivery-quality-v1 output and known-finding dispositions are complete.'],
  }),
});

export const qualityNodes = [qualityNode];
