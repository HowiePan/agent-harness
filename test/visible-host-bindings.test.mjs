import assert from 'node:assert/strict';
import test from 'node:test';
import { defineExtensionPack } from '../src/extensions/contract.mjs';
import { createCallbackRuntime } from '../src/plugins/runtime/callback-runtime.mjs';
import { createVisibleHostAdapter } from '../src/plugins/runtime/visible-host-adapter.mjs';
import { assertVisibleHostReceiptOwner, createVisibleHostBindings } from '../src/plugins/runtime/visible-host-bindings.mjs';
import { validateBusinessResult, VISIBLE_AGENT_RESULT_CONTRACT_VERSION } from '../src/result-contract.mjs';
import { featureDeliveryProfile } from '../src/profiles/feature-delivery.mjs';
import { command, dispatchAndBind, makeFixture, startRun } from './test-support.mjs';

const manifest = id => ({ id, kind: 'agent-runtime', version: '1.0.0', capabilities: ['spawn', 'wait', 'send', 'heartbeat', 'interrupt', 'user-visible', 'host-orchestrated', 'workspace-shared'], permissions: ['agent.conversation'] });
const host = provider => createVisibleHostAdapter({ provider, inspectVisibleAgent: async input => ({ verified: true, status: 'running', assertionId: `${provider}-assertion`, observedAt: new Date().toISOString(), agentId: input.agentId, dispatchId: input.dispatchId, packetDigest: input.packetDigest, promptDigest: input.promptDigest, visibility: { mode: 'user-visible', surface: input.surface, inspectRef: input.inspectRef } }) });

test('trusted visible hosts bind to exact Runtime plugin IDs and factories receive only their own host', async t => {
  const first = host('first-host');
  const second = host('second-host');
  const seen = new Map();
  const extension = defineExtensionPack({
    id: 'multi-host-fixture', version: '1.0.0',
    plugins: ['first-visible-runtime', 'second-visible-runtime'].map(id => ({ manifest: manifest(id), create: ({ agentAdapter }) => { seen.set(id, agentAdapter); return createCallbackRuntime({ manifest: manifest(id), adapter: agentAdapter }); } })),
  });
  const fixture = await makeFixture({ extensions: [extension], agentAdapters: { 'first-visible-runtime': first, 'second-visible-runtime': second }, policy: { agentExecutionMode: 'conversation-visible', runtimePlugins: ['first-visible-runtime', 'second-visible-runtime'], defaultRuntimePlugin: 'first-visible-runtime' } });
  t.after(() => fixture.cleanup());
  assert.equal(seen.get('first-visible-runtime'), first);
  assert.equal(seen.get('second-visible-runtime'), second);
  assert.equal(fixture.harness.getRuntimeManifest('first-visible-runtime').id, 'first-visible-runtime');
  assert.throws(() => assertVisibleHostReceiptOwner(second, { hostAttestation: { provider: first.provider, adapterVersion: first.adapterVersion } }), error => error.code === 'VISIBLE_HOST_RECEIPT_OWNER_MISMATCH');
  assert.equal(assertVisibleHostReceiptOwner(first, { hostAttestation: { provider: first.provider, adapterVersion: first.adapterVersion } }).provider, first.provider);
});

test('visible host bindings reject ambiguous, untrusted, or unknown Runtime bindings', async () => {
  const adapter = host('known-host');
  assert.throws(() => createVisibleHostBindings({ agentAdapter: adapter, agentAdapters: { 'first-visible-runtime': adapter } }), error => error.code === 'VISIBLE_HOST_BINDINGS_AMBIGUOUS');
  assert.throws(() => createVisibleHostBindings({ agentAdapters: { 'first-visible-runtime': { verifyVisibleLease() {} } } }), error => error.code === 'VISIBLE_AGENT_HOST_ADAPTER_REQUIRED');
  const bindings = createVisibleHostBindings({ agentAdapters: { 'first-visible-runtime': adapter } });
  assert.equal(bindings.resolve('first-visible-runtime'), adapter);
  assert.equal(bindings.resolve('second-visible-runtime'), null);
  assert.throws(() => bindings.assertInstalled({ get: () => { throw Object.assign(new Error('missing Runtime'), { code: 'PLUGIN_NOT_FOUND' }); } }), error => error.code === 'PLUGIN_NOT_FOUND');
});

test('portable visible result accepts provider-neutral fields while repair still requires verification', () => {
  assert.equal(VISIBLE_AGENT_RESULT_CONTRACT_VERSION, '1.0');
  const result = { status: 'completed', summary: 'Work completed.', changedFiles: [] };
  assert.deepEqual(validateBusinessResult(result, { conversationVisible: true }), result);
  assert.throws(() => validateBusinessResult(result, { conversationVisible: true, repair: true }), error => error.code === 'REPAIR_CHECKPOINT_REQUIRED');
  assert.throws(() => validateBusinessResult({ ...result, changedFiles: ['one', 'one'] }, { conversationVisible: true }), error => error.code === 'VISIBLE_RESULT_SCHEMA_INVALID');
});

test('a business Profile validates its result before Evidence or Authority submission', async t => {
  const profile = { ...featureDeliveryProfile, id: 'strict-result-profile', validateResult: ({ result }) => ({ ok: result.observations?.includes('business-check') === true, reason: 'business-check-required' }) };
  const extension = defineExtensionPack({ id: 'strict-result-extension', version: '1.0.0', profiles: [profile] });
  const fixture = await makeFixture({ profiles: ['strict-result-profile'], extensions: [extension] });
  t.after(() => fixture.cleanup());
  await startRun(fixture, { profileId: profile.id });
  const { dispatch } = await dispatchAndBind(fixture, 'run');
  await assert.rejects(() => fixture.harness.recordResult(fixture.projectId, 'run', dispatch.dispatchId, { status: 'completed', summary: 'missing check', changedFiles: [] }, { commandId: command().commandId }), error => error.code === 'PROFILE_RESULT_REJECTED' && error.details?.reason === 'business-check-required');
  assert.equal((await fixture.harness.authorityStore.read(fixture.projectId, 'run')).submissions.length, 0);
  const submitted = await fixture.harness.recordResult(fixture.projectId, 'run', dispatch.dispatchId, { status: 'completed', summary: 'checked', changedFiles: [], observations: ['business-check'] }, { commandId: command().commandId });
  assert.equal(submitted.result.submission.result.summary, 'checked');
});
