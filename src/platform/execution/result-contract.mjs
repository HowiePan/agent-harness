import { readFileSync } from 'node:fs';
import { digestJson } from '../../common/canonical.mjs';
import { assert } from '../../common/errors.mjs';
import { assertJsonSchema, assertSchemaDefinition } from '../../common/json-schema.mjs';
import { assertKnownFindingDispositions, assertKnownFindingInventory } from './known-finding-inventory.mjs';

const businessResultSchema = JSON.parse(readFileSync(new URL('../../../schemas/result.schema.json', import.meta.url), 'utf8'));
export const VISIBLE_AGENT_RESULT_CONTRACT_VERSION = '1.2';
const visibleResultSchema = JSON.parse(readFileSync(new URL('../../../schemas/visible-agent-result.schema.json', import.meta.url), 'utf8'));

export const createDispatchResultContract = (feature, { conversationVisible = false } = {}) => {
  const schema = conversationVisible ? visibleResultSchema : businessResultSchema;
  const outputPorts = Object.fromEntries(Object.entries(feature?.metadata?.outputPorts ?? {}).sort(([left], [right]) => left.localeCompare(right)));
  const declaredValueSchemas = feature?.metadata?.outputValueSchemas ?? {};
  const outputValueSchemas = {};
  for (const [portId, schemaId] of Object.entries(outputPorts)) {
    assert(/^[a-z][a-z0-9.-]{0,63}$/.test(portId) && typeof schemaId === 'string' && schemaId.length > 0, 'RESULT_OUTPUT_PORT_INVALID', 'Feature declares an invalid typed result port.');
    assert(Object.hasOwn(declaredValueSchemas, portId), 'RESULT_OUTPUT_VALUE_SCHEMA_REQUIRED', `Typed output port ${portId} requires a declared value Schema.`);
    const valueSchema = structuredClone(declaredValueSchemas[portId]);
    assertSchemaDefinition({ $schema: 'https://json-schema.org/draft/2020-12/schema', $id: `urn:agent-harness:output:${schemaId}`, ...valueSchema }, `Output port ${portId} Schema`);
    outputValueSchemas[portId] = valueSchema;
  }
  const body = {
    id: 'agent-harness-dispatch-result', version: VISIBLE_AGENT_RESULT_CONTRACT_VERSION, schemaId: schema.$id,
    schemaDigest: digestJson(schema), outputPorts, outputValueSchemas,
    qualityReview: feature?.metadata?.qualityReview === true,
    repair: Boolean(feature?.metadata?.repairFindingId),
    knownFindingInventory: feature?.metadata?.knownFindingInventory
      ? { inventoryDigest: assertKnownFindingInventory(feature.metadata.knownFindingInventory).inventoryDigest, findings: feature.metadata.knownFindingInventory.findings.map(item => ({ id: item.id, severity: item.severity })) }
      : null,
  };
  return Object.freeze({ ...body, contractDigest: digestJson(body) });
};

export const assertDispatchResultContract = (input, feature, options = {}) => {
  const expected = createDispatchResultContract(feature, options);
  const body = input && typeof input === 'object' ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'contractDigest')) : null;
  assert(input?.contractDigest === expected.contractDigest && digestJson(body) === expected.contractDigest, 'RESULT_CONTRACT_BINDING_MISMATCH', 'Dispatch result contract does not match its immutable Feature and transport schema.');
  return expected;
};

export const validateBusinessResult = (input, { conversationVisible = false, repair = false, feature = null } = {}) => {
  const result = structuredClone(input);
  assertJsonSchema(result, conversationVisible ? visibleResultSchema : businessResultSchema, {
    code: conversationVisible ? 'VISIBLE_RESULT_SCHEMA_INVALID' : 'RESULT_SCHEMA_INVALID',
    label: conversationVisible ? 'Conversation-visible Agent result' : 'Agent result',
  });
  assert(Buffer.byteLength(JSON.stringify(result.outputs ?? {})) <= 256 * 1024, 'RESULT_OUTPUT_BUDGET_EXCEEDED', 'Typed node outputs exceed 256 KiB.');
  for (const [portId, output] of Object.entries(result.outputs ?? {})) assert(/^[a-z][a-z0-9.-]{0,63}$/.test(portId) && output.schemaId, 'RESULT_OUTPUT_PORT_INVALID', 'Typed node output port is invalid.');
  if (result.status === 'completed' && feature?.metadata?.outputPorts) {
    const contract = createDispatchResultContract(feature, { conversationVisible });
    const declared = Object.keys(contract.outputPorts).sort();
    const actual = Object.keys(result.outputs ?? {}).sort();
    assert(digestJson(actual) === digestJson(declared), 'RESULT_OUTPUT_PORTS_MISMATCH', 'Completed Feature result must contain exactly its declared typed output ports.', { declared, actual });
    for (const [portId, schemaId] of Object.entries(contract.outputPorts)) {
      assert(result.outputs[portId].schemaId === schemaId, 'RESULT_OUTPUT_SCHEMA_ID_MISMATCH', `Typed output ${portId} has the wrong Schema ID.`);
      assertJsonSchema(result.outputs[portId].value, contract.outputValueSchemas[portId], { code: 'RESULT_OUTPUT_VALUE_SCHEMA_INVALID', label: `Typed output ${portId}` });
    }
  }
  if (repair && result.status === 'completed') {
    assert(Array.isArray(result.checkpoints) && result.checkpoints.length > 0, 'REPAIR_CHECKPOINT_REQUIRED', 'A completed repair requires at least one verification checkpoint.');
    assert(result.checkpoints.every(checkpoint => ['passed', 'completed'].includes(checkpoint.status) && Array.isArray(checkpoint.evidence) && checkpoint.evidence.length > 0), 'REPAIR_CHECKPOINT_EVIDENCE_REQUIRED', 'Every completed repair checkpoint must pass and cite non-empty evidence.');
    const groupedFindings = feature?.metadata?.repairFindingIds ?? [];
    if (groupedFindings.length > 1) assert(groupedFindings.every(id => result.checkpoints.some(checkpoint => checkpoint.id === `verify:${id}`)), 'REPAIR_FINDING_CHECKPOINT_REQUIRED', 'A grouped repair requires a passing focused checkpoint for every Finding.');
  }
  if (feature?.metadata?.qualityReview === true && result.status === 'completed' && feature.metadata.diagnostics?.length) {
    const expected = feature.metadata.diagnostics.map(item => item.id);
    const dispositions = result.diagnosticDispositions ?? [];
    assert(new Set(expected).size === expected.length && dispositions.length === expected.length && new Set(dispositions.map(item => item.id)).size === expected.length && dispositions.every(item => expected.includes(item.id) && (item.disposition !== 'finding' || (item.findingId && (result.findings ?? []).some(finding => finding.id === item.findingId)))), 'QUALITY_DIAGNOSTIC_DISPOSITION_REQUIRED', 'A diagnostic review must substantiate every carried check failure as a Finding or a fresh not-reproduced result.');
  }
  if (feature?.metadata?.qualityReview === true && feature.metadata.knownFindingInventory) assertKnownFindingDispositions(result, feature.metadata.knownFindingInventory);
  return result;
};

export const validateProfileResult = ({ profile, state, feature, result }) => {
  if (typeof profile.validateResult !== 'function') return result;
  const verdict = profile.validateResult({ state: structuredClone(state), feature: structuredClone(feature), result: structuredClone(result) });
  assert(verdict?.ok === true, 'PROFILE_RESULT_REJECTED', `Profile ${profile.id} rejected the Agent result.`, { reason: verdict?.reason ?? null });
  return result;
};

export const resultSchemas = Object.freeze({ business: businessResultSchema, conversationVisible: visibleResultSchema });
