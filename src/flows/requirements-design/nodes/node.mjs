import { requirementsValueSchemas } from '../contracts/index.mjs';

export const node = (id, dependsOn = [], options = {}) => ({
  id, template: 'reference-feature', dependsOn, ...options,
  outputValueSchemas: Object.fromEntries(Object.entries(options.outputPorts ?? {}).map(([portId, schemaId]) => [portId, requirementsValueSchemas[schemaId]])),
});
