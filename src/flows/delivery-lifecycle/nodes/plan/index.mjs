import { deliveryNode, deliveryTask } from '../node.mjs';

export const planNode = deliveryNode('plan', 'plan', 'version-planning', ['canonical'], {
  task: deliveryTask({
    role: { id: 'delivery-planner', description: 'Turns the canonical requirement into an executable, conflict-aware Feature plan.' },
    objective: 'Create a deterministic implementation plan that covers the canonical requirement end to end.',
    instructions: ['Consume the typed canonical requirement.', 'Decompose work into bounded Features with dependencies, ownership, paths, contracts, and verification.', 'Expose conflicts, ordering constraints, and protected operations.'],
    steps: [{ id: 'decompose', instruction: 'Decompose the requirement into independently verifiable Features.' }, { id: 'order', instruction: 'Build the dependency and conflict graph.' }, { id: 'verify-plan', instruction: 'Check complete requirement coverage and executable boundaries.' }],
    acceptance: ['Every canonical acceptance criterion maps to planned work and verification.', 'Dependencies and conflicts are explicit and acyclic.', 'The delivery-plan-v1 output lists the complete deterministic Feature plan.'],
  }),
});

export const planNodes = [planNode];
