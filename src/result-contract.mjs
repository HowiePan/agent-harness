import { readFileSync } from 'node:fs';
import { assert } from './errors.mjs';
import { assertJsonSchema } from './json-schema.mjs';

const businessResultSchema = JSON.parse(readFileSync(new URL('../schemas/result.schema.json', import.meta.url), 'utf8'));
const visibleResultSchema = JSON.parse(readFileSync(new URL('../schemas/codex-runtime-result.schema.json', import.meta.url), 'utf8'));

export const validateBusinessResult = (input, { conversationVisible = false, repair = false } = {}) => {
  const result = structuredClone(input);
  assertJsonSchema(result, conversationVisible ? visibleResultSchema : businessResultSchema, {
    code: conversationVisible ? 'VISIBLE_RESULT_SCHEMA_INVALID' : 'RESULT_SCHEMA_INVALID',
    label: conversationVisible ? 'Conversation-visible Agent result' : 'Agent result',
  });
  if (repair && result.status === 'completed') {
    assert(Array.isArray(result.checkpoints) && result.checkpoints.length > 0, 'REPAIR_CHECKPOINT_REQUIRED', 'A completed repair requires at least one verification checkpoint.');
    assert(result.checkpoints.every(checkpoint => ['passed', 'completed'].includes(checkpoint.status) && Array.isArray(checkpoint.evidence) && checkpoint.evidence.length > 0), 'REPAIR_CHECKPOINT_EVIDENCE_REQUIRED', 'Every completed repair checkpoint must pass and cite non-empty evidence.');
  }
  return result;
};

export const resultSchemas = Object.freeze({ business: businessResultSchema, conversationVisible: visibleResultSchema });
