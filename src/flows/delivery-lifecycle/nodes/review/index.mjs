import { deliveryNode, deliveryTask } from '../node.mjs';

export const reviewNode = deliveryNode('review', 'review', 'user-code-review', ['quality'], {
  readOnly: true,
  task: deliveryTask({
    role: { id: 'delivery-reviewer', description: 'Performs the final independent delivery review before clearance.' },
    objective: 'Confirm that the reviewed target is complete, understandable, supportable, and ready for final delivery approval.',
    instructions: ['Consume the typed quality result.', 'Review behavior, maintainability, documentation, compatibility, and unresolved risk.', 'Approve only from current evidence; otherwise report actionable blockers.'],
    steps: [{ id: 'inspect', instruction: 'Review the complete delivery evidence and current change set.' }, { id: 'decide', instruction: 'Return an evidence-backed review outcome without changing the workspace.' }],
    constraints: ['Remain read-only and independent from implementation claims.'],
    acceptance: ['All material delivery risks are addressed or explicitly block approval.', 'The delivery-review-v1 output sets approved=true only when evidence supports clearance.'],
  }),
});

export const reviewNodes = [reviewNode];
