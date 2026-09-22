import { requirementsValueSchemas } from '../contracts/index.mjs';
import { defineNodeTaskContract } from '../../../common/task-contract.mjs';

export const requirementsTask = ({ role, objective, instructions, steps, acceptance, inputs = [], constraints = [], evidenceRequirements = [] }) => ({
  role,
  objective,
  instructions,
  inputs: [
    { id: 'analysis-target', source: 'intent', path: 'target', required: true, description: 'The exact requirements/design analysis target.' },
    ...inputs,
  ],
  steps,
  constraints: [
    'Use only pinned sources and typed upstream outputs; do not invent requirements or code capabilities.',
    'Keep every conclusion traceable to an exact source location or explicitly mark it as unresolved.',
    ...constraints,
  ],
  acceptance,
  evidenceRequirements: [
    'Cite source IDs, paths, symbols, and source digests for every material fact.',
    'Return every declared typed output with non-empty evidence references.',
    ...evidenceRequirements,
  ],
});

export const node = (id, dependsOn = [], options = {}) => {
  const { task, ...nodeOptions } = options;
  return {
    id, template: 'reference-feature', dependsOn, ...nodeOptions,
    task: defineNodeTaskContract(task),
    outputValueSchemas: Object.fromEntries(Object.entries(options.outputPorts ?? {}).map(([portId, schemaId]) => [portId, requirementsValueSchemas[schemaId]])),
  };
};
