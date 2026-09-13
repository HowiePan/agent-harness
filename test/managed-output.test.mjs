import assert from 'node:assert/strict';
import test from 'node:test';
import { access, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createCommandWrapperSandbox, createManagedOutputSession, createProcessRuntime, PluginHost } from '../src/index.mjs';
import { makeFixture } from './test-support.mjs';

const declarations = maxBytes => [{ id: 'probe', retention: 'ephemeral', environment: ['PROBE_OUTPUT'], maxBytes, maxFiles: 10 }];
const runtimeManifest = outputs => ({ id: 'managed-process-runtime', kind: 'agent-runtime', version: '1.0.0', capabilities: ['spawn', 'wait', 'send', 'heartbeat', 'interrupt', 'managed-outputs'], permissions: ['process.spawn'], execution: { outputs, sandbox: { mode: 'optional' } } });

test('Plugin Host rejects a process plugin without managed output declarations', () => {
  const host = new PluginHost({ allowedPermissions: ['process.spawn'] });
  const manifest = { id: 'unmanaged-process', kind: 'agent-runtime', version: '1.0.0', capabilities: ['spawn', 'wait', 'send', 'heartbeat', 'interrupt'], permissions: ['process.spawn'] };
  const instance = { spawn() {}, wait() {}, send() {}, heartbeat() {}, interrupt() {} };
  assert.throws(() => host.register(manifest, instance), error => error.code === 'PLUGIN_MANAGED_OUTPUTS_REQUIRED');
});

test('managed output session measures budgets and returns a digest-bound cleanup receipt', async t => {
  const fixture = await makeFixture(); t.after(() => fixture.cleanup());
  const session = createManagedOutputSession({ root: resolve(fixture.dataRoot, 'managed'), operationId: 'measure', declarations: declarations(1024) });
  await session.prepare();
  await writeFile(resolve(session.paths.probe, 'result.bin'), Buffer.alloc(32));
  const measured = await session.inspect();
  assert.deepEqual(measured.outputs[0].usage, { files: 1, bytes: 32 });
  const receipt = await session.finish({ reason: 'test' });
  assert.equal(receipt.status, 'cleaned');
  assert.deepEqual(receipt.outputs[0].peakUsage, { files: 1, bytes: 32 });
  assert.equal(receipt.cleanup[0].removed, true);
  assert.deepEqual(receipt.remaining[0], { id: 'probe', files: 0, bytes: 0 });
  assert.match(receipt.receiptDigest, /^[a-f0-9]{64}$/);
  await assert.rejects(() => access(session.operationRoot), error => error.code === 'ENOENT');
});

test('Process Runtime terminates an over-budget output and still returns cleanup evidence', async t => {
  const fixture = await makeFixture(); t.after(() => fixture.cleanup());
  const outputs = declarations(16);
  const manifest = runtimeManifest(outputs);
  const runtime = createProcessRuntime({ manifest, executable: process.execPath, args: ['test/fixtures/managed-output-probe.mjs'], temporaryRoot: resolve(fixture.dataRoot, 'managed-runtime'), monitorIntervalMs: 10 });
  const spawned = await runtime.spawn({ bytes: 1024, delayMs: 250 });
  const waited = await runtime.wait({ agentId: spawned.payload.agentId });
  assert.equal(waited.payload.status, 'failed');
  assert.equal(waited.payload.failureKind, 'output-budget');
  assert.equal(waited.payload.outputReceipt.status, 'budget-exceeded');
  assert.equal(waited.payload.outputReceipt.violations[0].metric, 'bytes');
  assert.deepEqual(waited.payload.outputReceipt.remaining[0], { id: 'probe', files: 0, bytes: 0 });
  const cleaned = await runtime.cleanup({ agentId: spawned.payload.agentId });
  assert.equal(cleaned.payload.outputReceipt.receiptDigest, waited.payload.outputReceipt.receiptDigest);
});

test('required OS sandbox is fail-closed and an installed wrapper is recorded', async t => {
  const fixture = await makeFixture(); t.after(() => fixture.cleanup());
  const outputs = declarations(4096);
  const manifest = runtimeManifest(outputs);
  const missing = createProcessRuntime({ manifest, executable: process.execPath, args: ['test/fixtures/managed-output-probe.mjs'], temporaryRoot: resolve(fixture.dataRoot, 'missing-sandbox'), sandboxMode: 'required' });
  await assert.rejects(() => missing.spawn({ bytes: 1 }), error => error.code === 'OS_SANDBOX_REQUIRED');

  const badManifest = { id: 'bad-os-sandbox', kind: 'os-sandbox', version: '1.0.0', capabilities: ['command-wrapper'], permissions: [] };
  const badSandbox = { manifest: badManifest, instance: createCommandWrapperSandbox({ manifest: badManifest, wrap: launch => ({ ...launch, environment: { ...launch.environment, PROBE_OUTPUT: 'C:\\forbidden-output' } }) }) };
  const badRuntime = createProcessRuntime({ manifest, executable: process.execPath, args: ['test/fixtures/managed-output-probe.mjs'], temporaryRoot: resolve(fixture.dataRoot, 'bad-sandbox'), sandboxMode: 'required', sandbox: badSandbox });
  await assert.rejects(() => badRuntime.spawn({ bytes: 1 }), error => error.code === 'OS_SANDBOX_ENV_OVERRIDE');

  const sandboxManifest = { id: 'test-os-sandbox', kind: 'os-sandbox', version: '1.0.0', capabilities: ['command-wrapper'], permissions: ['process.spawn'] };
  const host = new PluginHost({ allowedPermissions: ['process.spawn'] });
  host.register(sandboxManifest, createCommandWrapperSandbox({ manifest: sandboxManifest, wrap: launch => ({ ...launch, environment: { ...launch.environment, SANDBOXED: 'true' } }) }));
  const runtime = createProcessRuntime({ manifest, executable: process.execPath, args: ['test/fixtures/managed-output-probe.mjs'], temporaryRoot: resolve(fixture.dataRoot, 'sandboxed-runtime'), sandboxMode: 'required', sandbox: host.get(sandboxManifest.id, 'os-sandbox') });
  const spawned = await runtime.spawn({ bytes: 8 });
  const waited = await runtime.wait({ agentId: spawned.payload.agentId });
  assert.equal(JSON.parse(waited.payload.stdout.trim()).sandboxed, true);
  assert.equal(waited.payload.outputReceipt.sandboxReceipt.applied, true);
  assert.equal(waited.payload.outputReceipt.sandboxReceipt.providerId, sandboxManifest.id);
  await runtime.cleanup({ agentId: spawned.payload.agentId });
});
