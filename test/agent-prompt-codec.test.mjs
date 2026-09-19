import assert from 'node:assert/strict';
import test from 'node:test';
import { digestJson, sha256 } from '../src/common/canonical.mjs';
import { AGENT_PROMPT_CONTRACT_VERSION, compileAgentPrompt, createAgentPromptCodec, REFERENCE_AGENT_PROMPT_CODEC_MANIFEST } from '../src/platform/plugins/codec/agent-prompt-codec.mjs';
import { validatePluginInstance, validatePluginManifest } from '../src/platform/plugins/contracts.mjs';

const packet = () => ({
  protocolVersion: '1.0',
  projectId: 'project',
  runId: 'run',
  profileId: 'feature-delivery',
  epoch: 1,
  generation: 1,
  dispatchId: 'dispatch-1',
  feature: { id: 'quality-review', ownerRole: 'reviewer', kind: 'quality', acceptance: ['Report every current P0-P3 finding'], allowedPaths: ['src/**'], forbiddenPaths: ['.git/**'], steps: [{ id: 'inspect', action: 'review current source' }] },
  outputRef: 'output.json',
  sourceDigest: 'a'.repeat(64),
  sourceSnapshotRef: 'evidence-1',
  policyDigest: 'b'.repeat(64),
  pluginSetDigest: 'c'.repeat(64),
  artifactDigest: null,
  gates: [],
  execution: { prompt: { pluginId: REFERENCE_AGENT_PROMPT_CODEC_MANIFEST.id, pluginVersion: REFERENCE_AGENT_PROMPT_CODEC_MANIFEST.version, contractVersion: AGENT_PROMPT_CONTRACT_VERSION } },
});

test('Prompt Codec deterministically compiles immutable Dispatch data into the full quality contract', () => {
  const first = compileAgentPrompt(packet());
  const second = compileAgentPrompt(packet());
  assert.deepEqual(first, second);
  assert.equal(first.packetDigest, digestJson(packet()));
  assert.equal(first.promptDigest, sha256(first.text));
  assert.match(first.text, /Authority and safety boundaries/);
  assert.match(first.text, /Required execution discipline/);
  assert.match(first.text, /Report every current P0-P3 finding/);
  assert.match(first.text, /Return exactly one structured JSON object/);
  assert.doesNotMatch(first.text, /generatedAt|new Date/);
});

test('Prompt digest changes with authoritative task data and codec binding cannot be bypassed', () => {
  const first = compileAgentPrompt(packet());
  const changed = packet();
  changed.feature.acceptance = ['Different acceptance'];
  assert.notEqual(compileAgentPrompt(changed).promptDigest, first.promptDigest);
  const unbound = packet();
  delete unbound.execution.prompt;
  assert.throws(() => compileAgentPrompt(unbound), error => error.code === 'AGENT_PROMPT_CODEC_BINDING_MISMATCH');
});

test('agent-prompt capability requires compilePrompt implementation', () => {
  const manifest = validatePluginManifest(REFERENCE_AGENT_PROMPT_CODEC_MANIFEST);
  assert.throws(() => validatePluginInstance(manifest, { encode() {}, decode() {} }), error => error.code === 'PLUGIN_CONTRACT_INVALID');
  assert.doesNotThrow(() => validatePluginInstance(manifest, createAgentPromptCodec({ manifest })));
});
