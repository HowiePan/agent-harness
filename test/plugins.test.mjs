import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInMemoryRuntime, createLocalArtifactProvider, createProcessGateExecutor, createWorkspaceToolBroker, DEFAULT_PROCESS_OUTPUTS, GateCache, loadPlugin, loadPluginFromManifest, PluginHost } from '../src/index.mjs';
import { command, feature, makeFixture, startRun } from './test-support.mjs';

test('Gate cache metrics is read-only when the cache directory is absent', async t => {
  const fixture = await makeFixture(); t.after(() => fixture.cleanup());
  const directory = resolve(fixture.dataRoot, 'cache', 'gates');
  await assert.rejects(() => access(directory), error => error.code === 'ENOENT');
  assert.deepEqual(await new GateCache({ root: fixture.dataRoot }).metrics(), { entries: 0 });
  await assert.rejects(() => access(directory), error => error.code === 'ENOENT');
});

test('external plugin modules load through the versioned Host contract', async t => {
  const fixture = await makeFixture(); t.after(() => fixture.cleanup());
  const host = new PluginHost();
  const manifest = await loadPlugin({ host, module: resolve('test/fixtures/external-scheduler.mjs'), config: { limit: 2 } });
  const output = await host.invoke(manifest.id, 'select', { features: [feature('a'), feature('b'), feature('c')] });
  assert.deepEqual(output.payload.featureIds, ['a', 'b']);
});

test('published plugin manifest resolves a matching executable entry module', async t => {
  const fixture = await makeFixture(); t.after(() => fixture.cleanup());
  const host = new PluginHost({ allowedPermissions: ['process.spawn'] });
  const manifest = await loadPluginFromManifest({
    host,
    manifestPath: resolve('plugins/process-runtime.plugin.json'),
    config: { executable: process.execPath, args: ['test/fixtures/process-agent.mjs'], cwd: process.cwd(), temporaryRoot: resolve(fixture.dataRoot, 'tmp', 'manifest-runtime') },
    context: { dataRoot: fixture.dataRoot },
  });
  assert.equal(manifest.id, 'local-process-runtime');
});

test('workspace Tool Broker enforces read/write authorization and expected digest', async t => {
  const fixture = await makeFixture(); t.after(() => fixture.cleanup());
  await mkdir(resolve(fixture.workspace, 'allowed'));
  const manifest = { id: 'workspace-tools', kind: 'tool-broker', version: '1.0.0', capabilities: ['read', 'write'], permissions: ['workspace.read', 'workspace.write'] };
  const broker = createWorkspaceToolBroker({ manifest, workspaceRoot: fixture.workspace, writablePaths: ['allowed'] });
  const read = await broker.invoke({ operation: 'read', path: 'README.md' });
  assert.match(read.payload.body, /Fixture/);
  const written = await broker.invoke({ operation: 'write', path: 'allowed/result.txt', body: 'ok' });
  assert.equal(await readFile(resolve(fixture.workspace, 'allowed/result.txt'), 'utf8'), 'ok');
  await assert.rejects(() => broker.invoke({ operation: 'write', path: 'denied.txt', body: 'no' }), error => error.code === 'TOOL_WRITE_DENIED');
  await assert.rejects(() => broker.invoke({ operation: 'write', path: 'allowed/result.txt', body: 'changed', expectedSha256: 'wrong' }), error => error.code === 'TOOL_WRITE_REVISION_CONFLICT');
  assert.ok(written.payload.sha256);
});

test('Artifact Provider verifies every packaged file digest', async t => {
  const fixture = await makeFixture(); t.after(() => fixture.cleanup());
  const artifactRoot = resolve(fixture.root, 'artifacts'); await mkdir(artifactRoot);
  await writeFile(resolve(artifactRoot, 'bundle.bin'), 'artifact');
  const { sha256 } = await import('../src/common/canonical.mjs');
  await writeFile(resolve(artifactRoot, 'manifest.json'), JSON.stringify({ version: '1.2.3', artifacts: [{ path: 'bundle.bin', sha256: sha256('artifact') }] }));
  const manifest = { id: 'artifact-provider', kind: 'artifact-provider', version: '1.0.0', capabilities: ['local'], permissions: ['artifact.read'] };
  const provider = createLocalArtifactProvider({ manifest, allowedRoot: artifactRoot });
  const output = await provider.resolve({ manifestPath: 'manifest.json' });
  assert.equal(output.payload.identity.version, '1.2.3');
  assert.ok(output.payload.identityDigest);
});

test('Gate Executor separates product failure from an executable receipt', async t => {
  const fixture = await makeFixture(); t.after(() => fixture.cleanup());
  const manifest = { id: 'process-gates', kind: 'gate-executor', version: '1.0.0', capabilities: ['process', 'managed-outputs'], permissions: ['gate.execute'], execution: { outputs: DEFAULT_PROCESS_OUTPUTS, sandbox: { mode: 'optional' } } };
  const progress = [];
  const executor = createProcessGateExecutor({ manifest, workspaceRoot: process.cwd(), temporaryRoot: resolve(fixture.dataRoot, 'tmp', 'gates'), allowlist: [{ id: 'probe', executable: process.execPath, args: ['test/fixtures/gate-probe.mjs'] }], onProgress: event => progress.push(event) });
  const passed = await executor.execute({ id: 'gate-pass', commandId: 'probe', args: [] });
  const failed = await executor.execute({ id: 'gate-fail', commandId: 'probe', args: ['--fail'] });
  assert.equal(passed.payload.status, 'passed');
  assert.ok(passed.payload.stdout.replaceAll('\\', '/').includes(fixture.dataRoot.replaceAll('\\', '/')));
  assert.equal(failed.payload.status, 'failed');
  assert.equal(failed.payload.exitCode, 2);
  assert(progress.some(event => event.phase === 'started'));
  assert(progress.some(event => event.phase === 'output' && event.stream === 'stdout'));
  assert(progress.some(event => event.phase === 'finished' && event.status === 'passed'));
});

test('Gate Executor enforces declared output budgets and cleans before returning', async t => {
  const fixture = await makeFixture(); t.after(() => fixture.cleanup());
  const outputs = [{ id: 'gate-build', retention: 'ephemeral', environment: ['GATE_OUTPUT'], maxBytes: 16, maxFiles: 10 }];
  const manifest = { id: 'budgeted-gate', kind: 'gate-executor', version: '1.0.0', capabilities: ['process', 'managed-outputs'], permissions: ['gate.execute'], execution: { outputs, sandbox: { mode: 'optional' } } };
  const executor = createProcessGateExecutor({ manifest, workspaceRoot: process.cwd(), temporaryRoot: resolve(fixture.dataRoot, 'tmp', 'budgeted-gate'), monitorIntervalMs: 10, allowlist: [{ id: 'budget', executable: process.execPath, args: ['test/fixtures/gate-output-probe.mjs', '1024', '250'] }], onProgress: () => {} });
  const result = await executor.execute({ id: 'budget', commandId: 'budget' });
  assert.equal(result.payload.status, 'budget-exceeded');
  assert.equal(result.payload.outputReceipt.violations[0].metric, 'bytes');
  assert.deepEqual(result.payload.outputReceipt.remaining[0], { id: 'gate-build', files: 0, bytes: 0 });
});

test('Process Gate refuses to launch without a live progress observer', async t => {
  const fixture = await makeFixture(); t.after(() => fixture.cleanup());
  const manifest = { id: 'unobserved-gate', kind: 'gate-executor', version: '1.0.0', capabilities: ['process', 'managed-outputs'], permissions: ['gate.execute'], execution: { outputs: DEFAULT_PROCESS_OUTPUTS, sandbox: { mode: 'optional' } } };
  const executor = createProcessGateExecutor({ manifest, workspaceRoot: process.cwd(), temporaryRoot: resolve(fixture.dataRoot, 'tmp', 'unobserved-gate'), allowlist: [{ id: 'probe', executable: process.execPath, args: ['test/fixtures/gate-probe.mjs'] }] });
  await assert.rejects(() => executor.execute({ id: 'unobserved', commandId: 'probe' }), error => error.code === 'PROCESS_PROGRESS_OBSERVER_REQUIRED');
});

test('Gate cache is success-only and all baseline digests participate in the key', async t => {
  const fixture = await makeFixture(); t.after(() => fixture.cleanup());
  const cache = new GateCache({ root: fixture.dataRoot });
  const input = { gateId: 'test', specDigest: 'spec', sourceDigest: 'source-a', toolchainDigest: 'tool', environmentDigest: 'env', pluginDigest: 'plugin' };
  assert.equal((await cache.get(input)).hit, false);
  await cache.put(input, { status: 'passed', evidenceRefs: ['sha256'] });
  assert.equal((await cache.get(input)).hit, true);
  assert.equal((await cache.get({ ...input, sourceDigest: 'source-b' })).hit, false);
  assert.equal((await cache.get(input, { forceFresh: true })).hit, false);
  await assert.rejects(() => cache.put(input, { status: 'failed' }), error => error.code === 'GATE_CACHE_SUCCESS_ONLY');
});

test('Application binds a Runtime receipt before accepting its result', async t => {
  const manifest = { id: 'app-memory-runtime', kind: 'agent-runtime', version: '1.0.0', capabilities: ['spawn', 'wait', 'send', 'heartbeat', 'interrupt', 'headless'], permissions: [] };
  const fixture = await makeFixture({ policy: { runtimePlugins: [manifest.id], defaultRuntimePlugin: manifest.id } }); t.after(() => fixture.cleanup());
  fixture.harness.registerPlugin(manifest, createInMemoryRuntime({ manifest, handler: async () => ({ status: 'completed', summary: 'runtime done', changedFiles: [] }) }));
  await startRun(fixture);
  let state = await fixture.harness.authorityStore.read(fixture.projectId, 'run');
  const scheduled = await fixture.harness.dispatch(fixture.projectId, 'run', { maxConcurrency: 1, runtimePluginId: manifest.id }, command(state));
  const dispatch = scheduled.result.dispatches[0];
  const spawned = await fixture.harness.spawnDispatch(fixture.projectId, 'run', dispatch.dispatchId, manifest.id, command().commandId);
  const waited = await fixture.harness.invokeBoundRuntime(fixture.projectId, 'run', dispatch.dispatchId, 'wait');
  const recorded = await fixture.harness.recordResult(fixture.projectId, 'run', dispatch.dispatchId, waited.payload.result, { commandId: command().commandId });
  assert.equal(recorded.state.features[0].state, 'completed');
});
