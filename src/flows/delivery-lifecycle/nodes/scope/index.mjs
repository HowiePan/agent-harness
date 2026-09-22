import { deliveryNode, deliveryTask } from '../node.mjs';

export const scopeNode = deliveryNode('scope', 'scope', 'scope-resolution', ['implement'], {
  task: deliveryTask({
    role: { id: 'scope-controller', description: 'Verifies that implemented changes remain inside the approved requirement and authority boundaries.' },
    objective: 'Resolve scope, path, dependency, and work-breakdown conflicts before documentation and quality review.',
    instructions: ['Compare the typed implementation result with the canonical scope and plan.', 'Identify unauthorized, missing, or conflicting work.', 'Resolve only what is permitted and surface anything requiring a decision.'],
    steps: [{ id: 'compare', instruction: 'Compare planned and actual scope, paths, and dependencies.' }, { id: 'resolve', instruction: 'Resolve safe discrepancies and record remaining blockers.' }],
    acceptance: ['No unauthorized path or unplanned behavior remains unaccounted for.', 'Missing or conflicting work has an explicit resolution or blocker.', 'The delivery-scope-v1 output reports resolved=true only when scope is coherent.'],
  }),
});

export const scopeNodes = [scopeNode];
