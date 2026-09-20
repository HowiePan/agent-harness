export const qaPorts = Object.freeze({
  question: 'question-v1', match: 'memory-match-v1', candidate: 'qa-candidate-v1', answer: 'qa-answer-v1', clarification: 'qa-clarification-v1',
});

const string = { type: 'string', minLength: 1 };
export const qaValueSchemas = Object.freeze({
  'question-v1': { type: 'object', required: ['question', 'revision'], properties: { question: string, revision: { type: 'integer', minimum: 1 } }, additionalProperties: true },
  'memory-match-v1': { type: 'object', required: ['hit'], properties: { hit: { type: 'boolean' } }, additionalProperties: true },
  'qa-candidate-v1': { type: 'object', required: ['ready', 'claim', 'sourceRef'], properties: { ready: { type: 'boolean' }, claim: { type: ['string', 'null'] }, sourceRef: string }, additionalProperties: true },
  'qa-answer-v1': { type: 'object', required: ['claim', 'claimFingerprint', 'evidence'], properties: { claim: string, claimFingerprint: string, evidence: { type: ['string', 'array', 'object', 'null'] } }, additionalProperties: true },
  'qa-clarification-v1': { type: 'object', required: ['missingEvidence', 'question'], properties: { missingEvidence: string, question: string }, additionalProperties: true },
});
