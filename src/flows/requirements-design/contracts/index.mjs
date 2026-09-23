import { stringSchema as string, stringsSchema as strings } from '../../../flow-kit/schema.mjs';

export const requirementsPorts = Object.freeze({
  facts: 'source-facts-v1',
  requirements: 'requirements-v1',
  code: 'code-evidence-v1',
  impact: 'impact-map-v1',
  architecture: 'code-architecture-v1',
  document: 'document-ref-v1',
  review: 'document-review-v1',
  knowledge: 'memory-candidates-v1',
});

export const requirementsValueSchemas = Object.freeze({
  'source-facts-v1': { type: 'object', required: ['text', 'sourceId'], properties: { text: string, sourceId: string }, additionalProperties: true },
  'requirements-v1': { type: 'object', required: ['facts'], properties: { facts: strings }, additionalProperties: true },
  'code-evidence-v1': { type: 'object', required: ['text', 'sourceId'], properties: { text: string, sourceId: string }, additionalProperties: true },
  'impact-map-v1': { type: 'object', required: ['code', 'requirement'], properties: { code: strings, requirement: string }, additionalProperties: true },
  'code-architecture-v1': { type: 'object', required: ['modules', 'capabilities', 'mappings'], properties: { modules: strings, capabilities: strings, mappings: { type: 'array', items: { type: 'object', required: ['capability', 'paths'], properties: { capability: string, paths: strings }, additionalProperties: true } } }, additionalProperties: true },
  'document-ref-v1': { type: 'object', required: ['path', 'sha256'], properties: { path: string, sha256: string }, additionalProperties: true },
  'document-review-v1': { type: 'object', required: ['passed', 'documents'], properties: { passed: { type: 'boolean' }, documents: strings }, additionalProperties: true },
  'memory-candidates-v1': { type: 'object', required: ['records'], properties: { records: { type: 'array', items: { type: 'object' } } }, additionalProperties: true },
});
