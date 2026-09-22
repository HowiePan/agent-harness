import { deliveryNode, deliveryTask } from '../node.mjs';

export const docsNode = deliveryNode('docs', 'docs', 'docs-closeout', ['scope'], {
  task: deliveryTask({
    role: { id: 'documentation-engineer', description: 'Synchronizes user and integration documentation with the verified implementation.' },
    objective: 'Make the documented behavior, configuration, constraints, and migration guidance match the resolved implementation.',
    instructions: ['Consume the typed scope result and inspect actual verified changes.', 'Update every affected current document and remove stale claims.', 'Document externally observable behavior, configuration, limits, and verification.'],
    steps: [{ id: 'inventory', instruction: 'Identify all documentation affected by the resolved implementation.' }, { id: 'update', instruction: 'Update documentation and examples to match current behavior.' }, { id: 'cross-check', instruction: 'Cross-check links, commands, fields, and stated constraints.' }],
    acceptance: ['Current documentation contains no known contradiction with the implementation.', 'Every externally visible change has adequate usage and constraint documentation.', 'The delivery-docs-v1 output lists all updated documents.'],
  }),
});

export const docsNodes = [docsNode];
