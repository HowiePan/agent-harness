export const batchWorkflowId = 'collection-batch-production';
export const batchProfileId = 'collection-batch';

export const batchPorts = Object.freeze({
  rules: 'batch-rules-v1',
  produce: 'batch-produce-v1',
  quality: 'batch-quality-v1',
  review: 'batch-review-v1',
  accept: 'batch-accept-v1',
  launch: 'batch-launch-v1',
  close: 'batch-close-v1',
});

const string = { type: 'string', minLength: 1 };
const strings = { type: 'array', items: string };

export const batchValueSchemas = Object.freeze({
  'batch-rules-v1': { type: 'object', required: ['ready'], properties: { ready: { type: 'boolean' } }, additionalProperties: true },
  'batch-produce-v1': { type: 'object', required: ['changedFiles'], properties: { changedFiles: strings }, additionalProperties: true },
  'batch-quality-v1': { type: 'object', required: ['findings'], properties: { findings: { type: 'array' } }, additionalProperties: true },
  'batch-review-v1': { type: 'object', required: ['reviewed'], properties: { reviewed: { type: 'boolean' } }, additionalProperties: true },
  'batch-accept-v1': { type: 'object', required: ['accepted'], properties: { accepted: { type: 'boolean' } }, additionalProperties: true },
  'batch-launch-v1': { type: 'object', required: ['launched'], properties: { launched: { type: 'boolean' } }, additionalProperties: true },
  'batch-close-v1': { type: 'object', required: ['closed'], properties: { closed: { type: 'boolean' } }, additionalProperties: true },
});
