import { readFileSync } from 'node:fs';
import { assert } from './errors.mjs';
import { assertJsonSchema } from './json-schema.mjs';

const businessResultSchema = JSON.parse(readFileSync(new URL('../schemas/result.schema.json', import.meta.url), 'utf8'));
export const VISIBLE_AGENT_RESULT_CONTRACT_VERSION = '1.0';
const visibleResultSchema = JSON.parse(readFileSync(new URL('../schemas/visible-agent-result.schema.json', import.meta.url), 'utf8'));

export const validateBusinessResult = (input, { conversationVisible = false, repair = false } = {}) => {
  const result = structuredClone(input);
  assertJsonSchema(result, conversationVisible ? visibleResultSchema : businessResultSchema, {
    code: conversationVisible ? 'VISIBLE_RESULT_SCHEMA_INVALID' : 'RESULT_SCHEMA_INVALID',
    label: conversationVisible ? 'Conversation-visible Agent result' : 'Agent result',
  });
  assert(Buffer.byteLength(JSON.stringify(result.outputs ?? {})) <= 256 * 1024, 'RESULT_OUTPUT_BUDGET_EXCEEDED', 'Typed node outputs exceed 256 KiB.');
  for (const [portId, output] of Object.entries(result.outputs ?? {})) assert(/^[a-z][a-z0-9.-]{0,63}$/.test(portId) && output.schemaId, 'RESULT_OUTPUT_PORT_INVALID', 'Typed node output port is invalid.');
  if (repair && result.status === 'completed') {
    assert(Array.isArray(result.checkpoints) && result.checkpoints.length > 0, 'REPAIR_CHECKPOINT_REQUIRED', 'A completed repair requires at least one verification checkpoint.');
    assert(result.checkpoints.every(checkpoint => ['passed', 'completed'].includes(checkpoint.status) && Array.isArray(checkpoint.evidence) && checkpoint.evidence.length > 0), 'REPAIR_CHECKPOINT_EVIDENCE_REQUIRED', 'Every completed repair checkpoint must pass and cite non-empty evidence.');
  }
  return result;
};

export const validateProfileResult = ({ profile, state, feature, result }) => {
  if (typeof profile.validateResult !== 'function') return result;
  const verdict = profile.validateResult({ state: structuredClone(state), feature: structuredClone(feature), result: structuredClone(result) });
  assert(verdict?.ok === true, 'PROFILE_RESULT_REJECTED', `Profile ${profile.id} rejected the Agent result.`, { reason: verdict?.reason ?? null });
  return result;
};

export const resultSchemas = Object.freeze({ business: businessResultSchema, conversationVisible: visibleResultSchema });
