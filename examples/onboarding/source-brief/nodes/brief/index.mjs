import { ports } from '../../contracts/index.mjs';

export const briefNodes = [{
  id: 'brief', template: 'reference-feature', dependsOn: [], readAllSources: true,
  outputKey: 'brief', outputPorts: { document: ports.document },
  outputValueSchemas: { document: { type: 'object', required: ['path'], properties: { path: { type: 'string', minLength: 1 } }, additionalProperties: true } },
  outputChecks: [{ portId: 'document', path: 'path', operator: 'output-path' }],
  acceptance: ['Read every pinned source available to the selected projects and write a concise evidence-backed brief.'],
}];
