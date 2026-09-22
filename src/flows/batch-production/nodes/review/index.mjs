import { batchNode, batchTask } from '../node.mjs';

export const reviewNode = batchNode('review', 'review', ['quality'], {
  readOnly: true,
  task: batchTask({
    role: { id: 'domain-reviewer', description: 'Performs the final domain review for one quality-checked item.' },
    objective: 'Confirm that the assigned item is correct, coherent with its domain, and ready for acceptance.',
    instructions: ['Consume the typed quality result.', 'Review domain behavior, usability, compatibility, and unresolved risk.', 'Return reviewed=true only from current evidence.'],
    steps: [{ id: 'domain-review', instruction: 'Review the entire item in its domain and batch context.' }, { id: 'record-outcome', instruction: 'Record an evidence-backed review outcome.' }],
    constraints: ['Remain read-only and independent from production claims.'],
    acceptance: ['All material domain and quality concerns are resolved or explicitly block review.', 'The batch-review-v1 output sets reviewed=true only when justified.'],
  }),
});

export const reviewNodes = [reviewNode];
