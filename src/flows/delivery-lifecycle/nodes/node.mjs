import { deliveryPorts, deliveryValueSchemas } from '../contracts/index.mjs';

export const deliveryNode = (id, action, stage, dependsOn = [], options = {}) => {
  const portKey = options.portKey ?? id;
  const schemaId = deliveryPorts[portKey];
  const outputValueSchemas = schemaId && deliveryValueSchemas[schemaId]
    ? { [portKey]: deliveryValueSchemas[schemaId] }
    : {};
  return {
    id,
    template: 'delivery-stage',
    action,
    stage,
    dependsOn,
    outputPorts: schemaId ? { [portKey]: schemaId } : {},
    outputValueSchemas,
    ...options,
  };
};
