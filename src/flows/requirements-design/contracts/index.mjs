export const requirementsPorts = Object.freeze({
  facts: 'source-facts-v1',
  requirements: 'requirements-v1',
  code: 'code-evidence-v1',
  impact: 'impact-map-v1',
  document: 'document-ref-v1',
  review: 'document-review-v1',
  knowledge: 'memory-candidates-v1',
});

const string = { type: 'string', minLength: 1 };
const strings = { type: 'array', items: string };
export const requirementsValueSchemas = Object.freeze({
  'source-facts-v1': { type: 'object', required: ['text', 'sourceId'], properties: { text: string, sourceId: string }, additionalProperties: true },
  'requirements-v1': { type: 'object', required: ['facts'], properties: { facts: strings }, additionalProperties: true },
  'code-evidence-v1': { type: 'object', required: ['text', 'sourceId'], properties: { text: string, sourceId: string }, additionalProperties: true },
  'impact-map-v1': { type: 'object', required: ['code', 'requirement'], properties: { code: strings, requirement: string }, additionalProperties: true },
  'document-ref-v1': { type: 'object', required: ['path', 'sha256'], properties: { path: string, sha256: string }, additionalProperties: true },
  'document-review-v1': { type: 'object', required: ['passed', 'documents'], properties: { passed: { type: 'boolean' }, documents: strings }, additionalProperties: true },
  'memory-candidates-v1': { type: 'object', required: ['records'], properties: { records: { type: 'array', items: { type: 'object' } } }, additionalProperties: true },
});
