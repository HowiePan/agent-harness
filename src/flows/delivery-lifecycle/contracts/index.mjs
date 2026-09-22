export const deliveryWorkflowId = 'delivery-lifecycle';
export const deliveryProfileId = 'delivery-lifecycle';

export const deliveryPorts = Object.freeze({
  intake: 'delivery-intake-v1',
  canonical: 'canonical-requirement-v1',
  plan: 'delivery-plan-v1',
  implement: 'delivery-implementation-v1',
  scope: 'delivery-scope-v1',
  docs: 'delivery-docs-v1',
  quality: 'delivery-quality-v1',
  review: 'delivery-review-v1',
  deliver: 'delivery-receipt-v1',
});

const string = { type: 'string', minLength: 1 };
const strings = { type: 'array', items: string };

export const deliveryValueSchemas = Object.freeze({
  'delivery-intake-v1': { type: 'object', required: ['requirements'], properties: { requirements: strings }, additionalProperties: true },
  'canonical-requirement-v1': { type: 'object', required: ['id', 'acceptance'], properties: { id: string, acceptance: strings }, additionalProperties: true },
  'delivery-plan-v1': { type: 'object', required: ['features'], properties: { features: strings }, additionalProperties: true },
  'delivery-implementation-v1': { type: 'object', required: ['changedFiles'], properties: { changedFiles: strings }, additionalProperties: true },
  'delivery-scope-v1': { type: 'object', required: ['resolved'], properties: { resolved: { type: 'boolean' } }, additionalProperties: true },
  'delivery-docs-v1': { type: 'object', required: ['documents'], properties: { documents: strings }, additionalProperties: true },
  'delivery-quality-v1': { type: 'object', required: ['findings'], properties: { findings: { type: 'array' } }, additionalProperties: true },
  'delivery-review-v1': { type: 'object', required: ['approved'], properties: { approved: { type: 'boolean' } }, additionalProperties: true },
  'delivery-receipt-v1': { type: 'object', required: ['receiptId', 'status'], properties: { receiptId: string, status: string }, additionalProperties: true },
});
