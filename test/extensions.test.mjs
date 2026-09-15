import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHarness, createStaticModelRouter, defineExtensionPack, digestJson, ExtensionRegistry, loadExtensionPack, projectDescriptorInput, projectDescriptorSchemas, ProjectRegistry, sha256, validateJsonSchema } from '../src/index.mjs';
import { extensionPack as engineDeliveryExtension } from '../src/consumers/cardworld-engine.mjs';
import { makeFixture, startRun } from './test-support.mjs';

test('default application installs no consumer, provider, or legacy extension', async t => {
  const fixture = await makeFixture(); t.after(() => fixture.cleanup());
  assert.deepEqual(fixture.harness.extensionSet.installed, []);
  assert.deepEqual(fixture.harness.profileRegistry.list(), [{ id: 'feature-delivery', version: '1.0.0' }]);
  await assert.rejects(() => fixture.harness.recovery.assess('cardworld-t1-t2-importer', { legacyRoot: fixture.root }), error => error.code === 'LEGACY_IMPORTER_NOT_FOUND');
});

test('project required Extension identity is checked before run creation', async t => {
  const missing = await makeFixture(); t.after(() => missing.cleanup());
  const descriptor = await missing.harness.projectRegistry.get(missing.projectId);
  await missing.harness.projectRegistry.register({ ...projectDescriptorInput(descriptor), extensions: [{ id: 'cardworld-engine-profile', version: '1.0.0' }] }, { expectedRevision: descriptor.revision, commandId: 'require-extension', authorityDecision: { actor: 'user', decision: 'approved' } });
  await assert.rejects(() => startRun(missing), error => error.code === 'PROJECT_EXTENSION_MISSING');

  const installed = await makeFixture({ profiles: ['engine-delivery'] }); t.after(() => installed.cleanup());
  assert.deepEqual(installed.harness.extensionSet.installed, [{ id: engineDeliveryExtension.id, version: engineDeliveryExtension.version }]);
});

test('project can pin the exact Harness release artifact', async t => {
  const fixture = await makeFixture(); t.after(() => fixture.cleanup());
  const descriptor = await fixture.harness.projectRegistry.get(fixture.projectId);
  await fixture.harness.projectRegistry.register({ ...projectDescriptorInput(descriptor), harness: { version: '1.0.0', artifactDigest: 'b'.repeat(64) } }, { expectedRevision: descriptor.revision, commandId: 'pin-harness', authorityDecision: { actor: 'user', decision: 'approved' } });
  await assert.rejects(() => startRun(fixture), error => error.code === 'PROJECT_HARNESS_DIGEST_MISMATCH');
});

test('production Project Registry requires exact Harness and Extension artifact identities', async t => {
  const fixture = await makeFixture(); t.after(() => fixture.cleanup());
  const registry = new ProjectRegistry({ root: resolve(fixture.root, 'strict-registry-data'), controlRoot: fixture.harness.controlRoot });
  await assert.rejects(
    () => registry.register({ id: 'strict-project', workspace: { root: fixture.workspace }, profiles: ['feature-delivery'] }, { commandId: 'strict-project' }),
    error => error.code === 'PROJECT_HARNESS_IDENTITY_REQUIRED',
  );
  const input = { id: 'strict-project', harness: { version: '1.0.0', artifactDigest: 'a'.repeat(64) }, workspace: { root: fixture.workspace }, profiles: ['feature-delivery'], extensions: [], policy: { agentExecutionMode: 'headless', defaultRuntimePlugin: 'test-runtime', runtimePlugins: ['test-runtime'], promptCodecPlugin: 'reference-agent-prompt-codec' } };
  const record = await registry.register(input, { commandId: 'strict-project-valid' });
  assert.equal(validateJsonSchema(input, projectDescriptorSchemas.input).valid, true);
  assert.equal(validateJsonSchema(record, projectDescriptorSchemas.record).valid, true);
  await assert.rejects(() => registry.register({ ...input, protocolVersion: '9.9' }, { expectedRevision: record.revision, commandId: 'override-protocol' }), error => error.code === 'PROJECT_DESCRIPTOR_ADDITIONAL_PROPERTY');
});

test('production Harness rejects Extension objects that bypass artifact verification', async t => {
  const fixture = await makeFixture(); t.after(() => fixture.cleanup());
  await assert.rejects(
    () => createHarness({ dataRoot: resolve(fixture.root, 'strict-extension-data'), extensions: [engineDeliveryExtension] }),
    error => error.code === 'EXTENSION_ARTIFACT_VERIFICATION_REQUIRED',
  );
});

test('Extension Pack rejects duplicates and invalid plugin factories', async () => {
  assert.throws(() => defineExtensionPack({ id: 'invalid-pack', version: '1.0.0', plugins: [{ manifest: {} }] }), error => error.code === 'EXTENSION_PLUGIN_INVALID');
});

test('Extension plugin factories cannot receive Authority stores', async t => {
  let received;
  const manifest = { id: 'restricted-context-scheduler', kind: 'scheduler', version: '1.0.0', capabilities: [], permissions: [] };
  const extension = defineExtensionPack({
    id: 'restricted-context',
    version: '1.0.0',
    plugins: [{ manifest, create: context => {
      received = context;
      return { async select() { return { type: 'intent', pluginId: manifest.id, pluginVersion: manifest.version, payload: { featureIds: [] } }; } };
    } }],
  });
  const fixture = await makeFixture({ extensions: [extension] }); t.after(() => fixture.cleanup());
  assert.deepEqual(Object.keys(received).sort(), ['agentAdapter', 'controlRoot', 'dataRoot', 'now', 'resolveProject']);
  assert.equal(Object.hasOwn(received, 'authorityStore'), false);
});

test('published extension subpath resolves through the generic loader', async () => {
  const loaded = await loadExtensionPack('agent-harness/consumers/cardworld-engine');
  assert.deepEqual({ id: loaded.id, version: loaded.version }, { id: 'cardworld-engine-profile', version: '1.0.0' });
  assert.match(loaded.digest, /^[a-f0-9]{64}$/);
});

test('Extension Registry persists entrypoints and rejects changed artifacts before import', async t => {
  const fixture = await makeFixture(); t.after(() => fixture.cleanup());
  const directory = resolve(fixture.root, 'extensions');
  const entry = resolve(directory, 'sample.mjs');
  await mkdir(directory, { recursive: true });
  const source = "export default { id: 'sample-extension', version: '1.0.0' };\n";
  await writeFile(entry, source, 'utf8');
  const files = [{ path: 'sample.mjs', sha256: sha256(Buffer.from(source)), size: Buffer.byteLength(source) }];
  await writeFile(resolve(directory, 'agent-harness-extension.json'), `${JSON.stringify({ protocolVersion: '1.0', id: 'sample-extension', version: '1.0.0', entry: 'sample.mjs', files, artifactDigest: digestJson(files) }, null, 2)}\n`, 'utf8');
  const registry = new ExtensionRegistry({ dataRoot: fixture.dataRoot, controlRoot: fixture.harness.controlRoot });
  const decision = { actor: 'test-user', decision: 'approved' };
  await assert.rejects(() => registry.register(entry, { expectedRevision: 0, commandId: 'unapproved-install' }), error => error.code === 'EXTENSION_AUTHORITY_DECISION_REQUIRED');
  const receipt = await registry.register(entry, { expectedRevision: 0, commandId: 'install-sample', authorityDecision: decision });
  assert.match(receipt.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(await registry.register(entry, { expectedRevision: 0, commandId: 'install-sample', authorityDecision: decision }), receipt);
  assert.equal((await registry.list()).revision, 1);
  const restartedRegistry = new ExtensionRegistry({ dataRoot: fixture.dataRoot, controlRoot: fixture.harness.controlRoot });
  assert.equal((await restartedRegistry.loadInstalled())[0].id, 'sample-extension');
  await writeFile(entry, "export default { id: 'sample-extension', version: '1.0.0', operations: {} };\n", 'utf8');
  await assert.rejects(() => restartedRegistry.loadInstalled(), error => error.code === 'EXTENSION_ARTIFACT_DIGEST_MISMATCH');
  await writeFile(entry, source, 'utf8');
  assert.deepEqual(await restartedRegistry.remove('sample-extension', { expectedRevision: 1, commandId: 'remove-sample', authorityDecision: decision }), receipt);
  assert.deepEqual(await restartedRegistry.remove('sample-extension', { expectedRevision: 1, commandId: 'remove-sample', authorityDecision: decision }), receipt);
  assert.equal((await restartedRegistry.list()).revision, 2);
});

test('project Extension artifact digest is enforced before run creation', async t => {
  const loaded = await loadExtensionPack('agent-harness/consumers/cardworld-engine');
  const fixture = await makeFixture({ extensions: [loaded] }); t.after(() => fixture.cleanup());
  const descriptor = await fixture.harness.projectRegistry.get(fixture.projectId);
  await fixture.harness.projectRegistry.register({ ...projectDescriptorInput(descriptor), profiles: ['engine-delivery'], extensions: [{ id: loaded.id, version: loaded.version, digest: 'f'.repeat(64) }] }, { expectedRevision: descriptor.revision, commandId: 'pin-extension', authorityDecision: { actor: 'user', decision: 'approved' } });
  await assert.rejects(() => startRun(fixture, { profileId: 'engine-delivery' }), error => error.code === 'PROJECT_EXTENSION_DIGEST_MISMATCH');
});

test('reference model router fails closed when no route is configured', async () => {
  const manifest = { id: 'model-router', kind: 'model-router', version: '1.0.0', capabilities: [], permissions: [] };
  const router = createStaticModelRouter({ manifest, routes: [] });
  await assert.rejects(() => router.route({ role: 'worker', capabilities: [], risk: 0 }), error => error.code === 'MODEL_ROUTE_NOT_CONFIGURED');
});
