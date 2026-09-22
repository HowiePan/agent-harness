import { batchPorts, batchValueSchemas } from '../contracts/index.mjs';
import { defineNodeTaskContract } from '../../../common/task-contract.mjs';

export const batchTask = ({ role, objective, instructions, steps, acceptance, inputs = [], constraints = [] }) => ({
  role,
  objective,
  instructions,
  inputs: [
    { id: 'batch-target', source: 'intent', path: 'target', required: true, description: 'The exact batch selected by the lifecycle command.' },
    { id: 'item', source: 'feature', path: 'itemId', required: true, description: 'The exact logical item assigned to this Feature.' },
    ...inputs,
  ],
  steps,
  constraints: [
    'Operate only on the assigned item and preserve the batch barrier and declared dependency graph.',
    'Stay within the Feature write allowlist and never infer acceptance from another item.',
    ...constraints,
  ],
  acceptance,
  evidenceRequirements: [
    'Bind evidence to the exact batch, item, source digest, and checks actually observed.',
    'Return every declared typed output with evidence references and an exact changedFiles list.',
  ],
});

export const batchNode = (id, action, dependsOn = [], options = {}) => {
  const { task, ...nodeOptions } = options;
  const portKey = options.portKey ?? id;
  const schemaId = batchPorts[portKey];
  const outputValueSchemas = schemaId && batchValueSchemas[schemaId]
    ? { [portKey]: batchValueSchemas[schemaId] }
    : {};
  return {
    id,
    template: 'batch-stage',
    action,
    forEach: 'item',
    dependsOn,
    outputPorts: schemaId ? { [portKey]: schemaId } : {},
    outputValueSchemas,
    ...nodeOptions,
    task: defineNodeTaskContract(task),
  };
};
