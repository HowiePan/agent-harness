import { qaValueSchemas } from '../contracts/index.mjs';
import { defineNodeTaskContract } from '../../../common/task-contract.mjs';

export const qaTask = ({ role, objective, instructions, steps, acceptance, inputs = [], constraints = [], evidenceRequirements = [] }) => ({
  role,
  objective,
  instructions,
  inputs: [
    { id: 'question-target', source: 'intent', path: 'target', required: true, description: 'The exact question target selected for this workflow instance.' },
    ...inputs,
  ],
  steps,
  constraints: [
    'Use only authorized memory and pinned sources; never convert an unsupported candidate into a fact.',
    'Do not repeat a rejected claim and ask for clarification when the available evidence is insufficient.',
    ...constraints,
  ],
  acceptance,
  evidenceRequirements: [
    'Bind every answer claim to non-empty evidence and the current source coverage.',
    'Return every declared typed output with non-empty evidence references.',
    ...evidenceRequirements,
  ],
});

export const node = (id, dependsOn = [], options = {}) => {
  const { task, ...nodeOptions } = options;
  return {
    id, template: 'reference-feature', dependsOn, ...nodeOptions,
    task: defineNodeTaskContract(task),
    outputValueSchemas: Object.fromEntries(Object.entries(options.outputPorts ?? {}).map(([portId, schemaId]) => [portId, qaValueSchemas[schemaId]])),
  };
};
