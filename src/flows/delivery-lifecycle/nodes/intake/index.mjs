import { deliveryNode, deliveryTask } from '../node.mjs';

export const intakeNode = deliveryNode('intake', 'requirements-intake', 'requirement-intake', [], {
  task: deliveryTask({
    role: { id: 'requirements-analyst', description: 'Collects authoritative delivery requirements without inventing scope.' },
    objective: 'Build a complete, source-grounded intake for the selected delivery target.',
    instructions: ['Inspect the approved command intent and relevant project sources.', 'Separate explicit requirements, assumptions, ambiguities, constraints, and missing decisions.'],
    steps: [{ id: 'collect', instruction: 'Collect every authoritative requirement and its source.' }, { id: 'normalize', instruction: 'Normalize duplicates and expose ambiguities without resolving them silently.' }],
    acceptance: ['Every discovered requirement is represented once with its scope and source.', 'Ambiguities and missing decisions are explicit.', 'The delivery-intake-v1 output is complete and evidence-backed.'],
  }),
});

export const canonicalNode = deliveryNode('canonical', 'canonical-requirement', 'canonical-requirement', ['intake'], {
  task: deliveryTask({
    role: { id: 'requirements-owner', description: 'Converts the approved intake into one canonical delivery contract.' },
    objective: 'Produce the single canonical requirement that governs the remaining delivery lifecycle.',
    instructions: ['Consume the typed intake output.', 'Define exact in-scope and out-of-scope boundaries and testable acceptance criteria.', 'Preserve unresolved decisions instead of guessing.'],
    steps: [{ id: 'consolidate', instruction: 'Consolidate the intake into one internally consistent requirement.' }, { id: 'bound', instruction: 'Specify scope boundaries and measurable acceptance criteria.' }],
    acceptance: ['The canonical requirement has a stable identity and non-empty acceptance criteria.', 'Every intake requirement is covered, rejected with reason, or marked unresolved.', 'The canonical-requirement-v1 output is suitable for an explicit approval decision.'],
  }),
});

export const intakeNodes = [intakeNode, canonicalNode];
