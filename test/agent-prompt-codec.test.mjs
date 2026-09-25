import assert from 'node:assert/strict';
import test from 'node:test';
import { digestJson, sha256 } from '../src/common/canonical.mjs';
import { AGENT_PROMPT_CONTRACT_VERSION, compileAgentPrompt, createAgentPromptCodec, REFERENCE_AGENT_PROMPT_CODEC_MANIFEST } from '../src/platform/plugins/codec/agent-prompt-codec.mjs';
import { validatePluginInstance, validatePluginManifest } from '../src/platform/plugins/contracts.mjs';
import { createDispatchResultContract } from '../src/platform/execution/result-contract.mjs';
import { taskContract } from './test-support.mjs';

const packet = () => ({
  protocolVersion: '1.0',
  projectId: 'project',
  runId: 'run',
  profileId: 'feature-delivery',
  epoch: 1,
  generation: 1,
  dispatchId: 'dispatch-1',
  feature: { id: 'quality-review', task: taskContract('quality-review', ['Report every current P0-P3 finding']), ownerRole: 'reviewer', kind: 'quality', acceptance: ['Report every current P0-P3 finding'], allowedPaths: ['src/**'], forbiddenPaths: ['.git/**'], steps: [{ id: 'inspect', action: 'review current source' }] },
  outputRef: 'output.json',
  sourceDigest: 'a'.repeat(64),
  sourceSnapshotRef: 'evidence-1',
  policyDigest: 'b'.repeat(64),
  pluginSetDigest: 'c'.repeat(64),
  artifactDigest: null,
  gates: [],
  workflowContext: { workflow: null, sourceManifest: null, memorySnapshot: null, upstreamOutputs: {}, taskInputs: [] },
  execution: { prompt: { pluginId: REFERENCE_AGENT_PROMPT_CODEC_MANIFEST.id, pluginVersion: REFERENCE_AGENT_PROMPT_CODEC_MANIFEST.version, contractVersion: AGENT_PROMPT_CONTRACT_VERSION }, result: createDispatchResultContract({ metadata: {} }) },
});

test('Prompt Codec deterministically compiles immutable Dispatch data into the full quality contract', () => {
  const first = compileAgentPrompt(packet());
  const second = compileAgentPrompt(packet());
  assert.deepEqual(first, second);
  assert.equal(first.packetDigest, digestJson(packet()));
  assert.equal(first.promptDigest, sha256(first.text));
  assert.match(first.text, /Authority and safety boundaries/);
  assert.match(first.text, /Required execution discipline/);
  assert.match(first.text, /Node Task Contract/);
  assert.match(first.text, /Resolved inputs/);
  assert.match(first.text, new RegExp(packet().feature.task.taskDigest));
  assert.match(first.text, /Report every current P0-P3 finding/);
  assert.match(first.text, /Return exactly one JSON object/);
  assert.match(first.text, /"outputs"/);
  assert.match(first.text, /"affectedPaths"/);
  assert.match(first.text, /successful output ports are not required/);
  assert.match(first.text, new RegExp(packet().execution.result.contractDigest));
  assert.doesNotMatch(first.text, /generatedAt|new Date/);
});

test('Prompt Codec preserves the original 1.0 prompt for an active historical Dispatch', () => {
  const old = packet();
  old.execution.prompt.contractVersion = '1.0';
  const compiled = compileAgentPrompt(old);
  assert.equal(compiled.contractVersion, '1.0');
  assert.match(compiled.text, /It must conform to the Runtime result schema supplied by the host/);
  assert.doesNotMatch(compiled.text, /complete business transport shape/);
});

test('Prompt Codec can still recompile an active 1.2 Dispatch without a Node Task Contract', () => {
  const old = packet();
  old.execution.prompt.contractVersion = '1.2';
  delete old.feature.task;
  delete old.workflowContext;
  const compiled = compileAgentPrompt(old);
  assert.equal(compiled.contractVersion, '1.2');
  assert.doesNotMatch(compiled.text, /Node Task Contract/);
  assert.match(compiled.text, /Result-Contract:/);
});

test('Prompt Codec preserves the full 1.3 Prompt for an active visible Dispatch', () => {
  const old = packet();
  old.execution.prompt.contractVersion = '1.3';
  old.execution.runtime = { mode: 'conversation-visible', userVisible: true, hostOrchestrated: true };
  old.execution.result = createDispatchResultContract(old.feature, { conversationVisible: true });
  const compiled = compileAgentPrompt(old);
  assert.equal(compiled.contractVersion, '1.3');
  assert.match(compiled.text, /## Feature acceptance data/);
  assert.match(compiled.text, /BEGIN_AGENT_HARNESS_DISPATCH_PACKET_JSON/);
});

test('visible 1.4 Prompt names the digest-bound packet file without duplicating the packet', () => {
  const visible = packet();
  visible.outputRef = '/tmp/dispatch-output.json';
  visible.execution.runtime = { mode: 'conversation-visible', userVisible: true, hostOrchestrated: true };
  visible.execution.result = createDispatchResultContract(visible.feature, { conversationVisible: true });
  const compiled = compileAgentPrompt(visible);
  assert.equal(compiled.contractVersion, '1.4');
  assert.match(compiled.text, /dispatch-output\.json\.dispatch-packet\.json/);
  assert.match(compiled.text, new RegExp(compiled.packetDigest));
  assert.doesNotMatch(compiled.text, /BEGIN_AGENT_HARNESS_DISPATCH_PACKET_JSON/);
});

test('quality repair Prompt separates source edits from declared verification artifacts', () => {
  const repair = packet();
  repair.feature.id = 'quality-repair';
  repair.feature.allowedPaths = ['src/board.rs'];
  repair.feature.metadata = { stage: 'quality-repair', repairFindingId: 'Q-1', verificationOutputPaths: ['.build-output'] };
  repair.execution.runtime = { mode: 'conversation-visible', userVisible: true, hostOrchestrated: true };
  repair.execution.result = createDispatchResultContract(repair.feature, { conversationVisible: true });
  const compiled = compileAgentPrompt(repair);
  assert.match(compiled.text, /Edit source only within allowedPaths/);
  assert.match(compiled.text, /\.build-output/);
  assert.match(compiled.text, /transient build and test artifacts/);
  assert.match(compiled.text, /verification-path-prohibited/);
  assert.match(compiled.text, /Never edit source there or include those artifacts in changedFiles/);
});

test('Prompt Codec renders the fixed-schema typed output dialect without weakening the business contract', () => {
  const fixed = packet();
  fixed.execution.runtime = { mode: 'headless', userVisible: false, hostOrchestrated: false, resultDialect: 'typed-output-envelope-v1' };
  const compiled = compileAgentPrompt(fixed);
  assert.match(compiled.text, /typed-output-envelope-v1/);
  assert.match(compiled.text, /valueJson/);
  assert.match(compiled.text, /Harness decodes this envelope back into outputs before business validation/);
  assert.match(compiled.text, /complete business transport shape/);
});

test('Prompt digest changes with authoritative task data and codec binding cannot be bypassed', () => {
  const first = compileAgentPrompt(packet());
  const changed = packet();
  changed.feature.acceptance = ['Different acceptance'];
  assert.notEqual(compileAgentPrompt(changed).promptDigest, first.promptDigest);
  const unbound = packet();
  delete unbound.execution.prompt;
  assert.throws(() => compileAgentPrompt(unbound), error => error.code === 'AGENT_PROMPT_CODEC_BINDING_MISMATCH');
  const missingResult = packet();
  delete missingResult.execution.result;
  assert.throws(() => compileAgentPrompt(missingResult), error => error.code === 'RESULT_CONTRACT_BINDING_MISMATCH');
  const changedResult = packet();
  changedResult.execution.result = { ...changedResult.execution.result, outputPorts: { unexpected: 'wrong-v1' } };
  assert.throws(() => compileAgentPrompt(changedResult), error => error.code === 'RESULT_CONTRACT_BINDING_MISMATCH');
});

test('agent-prompt capability requires compilePrompt implementation', () => {
  const manifest = validatePluginManifest(REFERENCE_AGENT_PROMPT_CODEC_MANIFEST);
  assert.throws(() => validatePluginInstance(manifest, { encode() {}, decode() {} }), error => error.code === 'PLUGIN_CONTRACT_INVALID');
  assert.doesNotThrow(() => validatePluginInstance(manifest, createAgentPromptCodec({ manifest })));
});
