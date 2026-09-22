import { batchPorts, batchValueSchemas } from '../contracts/index.mjs';

export const batchNode = (id, action, dependsOn = [], options = {}) => {
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
    ...options,
  };
};
