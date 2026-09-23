import { deliveryNode, deliveryTask } from '../node.mjs';

export const expansionNode = deliveryNode('expansion', 'requirement-expansion', 'requirement-expansion', ['intake'], {
  task: deliveryTask({
    role: { id: 'requirements-expander', description: 'Expands the intake requirement direction against the bound project without inventing unrelated scope.' },
    objective: 'Derive a complete, source-grounded requirement set by combining the intake direction with the bound project documents and actual project state.',
    instructions: ['Consume the typed intake output.', 'Read the bound requirement/version documents and relevant project files within the Feature allowlist.', 'Expand each requirement direction into concrete, testable requirements and edge cases grounded in observed project reality.', 'Mark assumptions and unresolved items explicitly instead of guessing.'],
    steps: [{ id: 'expand', instruction: 'Expand every intake requirement direction into concrete requirements.' }, { id: 'ground', instruction: 'Ground each derived requirement in bound documents or observed project evidence.' }, { id: 'reconcile', instruction: 'Expose assumptions, gaps, and unresolved items without inventing scope.' }],
    acceptance: ['Every intake requirement direction is expanded or explicitly left unchanged with reason.', 'Derived requirements cite bound-document or project evidence.', 'Assumptions and unresolved items are explicit.', 'The delivery-expansion-v1 output is complete and evidence-backed.'],
  }),
});

export const expansionNodes = [expansionNode];
