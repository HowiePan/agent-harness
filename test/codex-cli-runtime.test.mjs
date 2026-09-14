import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createCodexCliRuntime, resolveCodexExecutionPolicy, validateCodexStructuredOutputSchema } from '../src/plugins/runtime/codex-cli-runtime.mjs';
import { businessResultFromRuntime } from '../src/coordinator/run-coordinator.mjs';
import { makeFixture } from './test-support.mjs';

test('Codex CLI execution policy emits one mutually exclusive approval or sandbox mode', () => {
  assert.deepEqual(resolveCodexExecutionPolicy({ sandbox: 'workspace-write', approveForMe: true }), {
    sandbox: 'workspace-write', approvalMode: 'approve-for-me', cliArgs: ['--approve-for-me'],
  });
  assert.deepEqual(resolveCodexExecutionPolicy({ sandbox: 'workspace-write', approveForMe: false }), {
    sandbox: 'workspace-write', approvalMode: 'sandbox-only', cliArgs: ['--sandbox', 'workspace-write'],
  });
  assert.deepEqual(resolveCodexExecutionPolicy({ sandbox: 'read-only' }), {
    sandbox: 'read-only', approvalMode: 'sandbox-only', cliArgs: ['--sandbox', 'read-only'],
  });
  assert.throws(() => resolveCodexExecutionPolicy({ sandbox: 'read-only', approveForMe: true }), error => error.code === 'CODEX_APPROVAL_SANDBOX_CONFLICT');
  assert.throws(() => resolveCodexExecutionPolicy({ sandbox: 'danger-full-access', approveForMe: false }), error => error.code === 'CODEX_DANGER_SANDBOX_DENIED');
  assert.throws(() => resolveCodexExecutionPolicy({ sandbox: 'workspace-write', approveForMe: 'yes' }), error => error.code === 'CODEX_APPROVAL_POLICY_INVALID');
});

test('Codex Runtime output Schema is strict and every object property is required', async () => {
  const schema = JSON.parse(await readFile(resolve('schemas/codex-runtime-result.schema.json'), 'utf8'));
  assert.equal(validateCodexStructuredOutputSchema(schema), schema);
  assert.throws(() => validateCodexStructuredOutputSchema({ ...schema, additionalProperties: true }), error => error.code === 'CODEX_OUTPUT_SCHEMA_INVALID');
  assert.throws(() => validateCodexStructuredOutputSchema({ ...schema, $defs: { loose: { type: 'object', properties: { value: { type: 'string' } }, required: [], additionalProperties: true } } }), error => error.code === 'CODEX_OUTPUT_SCHEMA_INVALID');
});

test('Codex CLI Runtime rejects an invalid output Schema before spawning a process', async t => {
  const fixture = await makeFixture({ policy: { runtimePlugins: ['codex-cli-runtime'], defaultRuntimePlugin: 'codex-cli-runtime' } });
  t.after(() => fixture.cleanup());
  const schemaPath = resolve(fixture.root, 'invalid-output-schema.json');
  await writeFile(schemaPath, JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'urn:invalid', type: 'object', properties: {}, required: [], additionalProperties: true }), 'utf8');
  const runtime = createCodexCliRuntime({ resolveProject: id => fixture.harness.projectRegistry.get(id), runtimeRoot: fixture.dataRoot, schemaPath, spawnProcess: () => { throw new Error('must not spawn'); } });
  await assert.rejects(() => runtime.spawn({ projectId: fixture.projectId, dispatchId: 'dispatch-invalid-schema', feature: { id: 'probe', allowedPaths: ['src'], forbiddenPaths: [] } }), error => error.code === 'CODEX_OUTPUT_SCHEMA_INVALID');
  await assert.rejects(() => access(resolve(fixture.dataRoot, 'runtime')), error => error.code === 'ENOENT');
});

test('Codex CLI Runtime uses non-interactive structured output and records transport evidence', async t => {
  const fixture = await makeFixture({ policy: { runtimePlugins: ['codex-cli-runtime'], defaultRuntimePlugin: 'codex-cli-runtime', runtimeConfigs: { 'codex-cli-runtime': { sandbox: 'workspace-write', approveForMe: true } } } });
  t.after(() => fixture.cleanup());
  const runtime = createCodexCliRuntime({ resolveProject: id => fixture.harness.projectRegistry.get(id), runtimeRoot: fixture.dataRoot, executable: process.execPath, executableArgs: [resolve('test/fixtures/codex-cli-probe.mjs')] });
  const executionWorkspace = resolve(fixture.root, 'execution-workspace');
  await mkdir(executionWorkspace, { recursive: true });
  const spawned = await runtime.spawn({ projectId: fixture.projectId, dispatchId: 'dispatch-probe', workspace: { root: executionWorkspace }, feature: { id: 'probe', allowedPaths: ['src'], forbiddenPaths: [] } });
  assert.equal(spawned.payload.transportReceipt.workspaceRoot, executionWorkspace);
  assert.equal(spawned.payload.transportReceipt.approvalMode, 'approve-for-me');
  const waited = await runtime.wait({ agentId: spawned.payload.agentId });
  assert.equal(waited.payload.status, 'completed');
  assert.equal(waited.payload.result.status, 'completed');
  assert.equal(waited.payload.threadId, 'probe-thread');
  assert.ok(waited.payload.events[0].temp.startsWith(fixture.dataRoot));
  assert(waited.payload.events[0].args.includes('--approve-for-me'));
  assert.equal(waited.payload.events[0].args.includes('--sandbox'), false);
  assert.deepEqual(waited.payload.sandboxReceipt, { mode: 'workspace-write', approvalMode: 'approve-for-me', requested: true, applied: true, providerId: 'codex-cli-runtime' });
  assert.ok(waited.payload.eventsDigest);
  const cleanup = await runtime.cleanup({ agentId: spawned.payload.agentId });
  assert.equal(cleanup.payload.outputReceipt.status, 'cleaned');
  assert.equal(cleanup.payload.outputReceipt.outputs.find(output => output.id === 'debug').usage.files, 2);
  assert.equal(cleanup.payload.outputReceipt.remaining.every(output => output.files === 0 && output.bytes === 0), true);
  await assert.rejects(() => access(dirname(waited.payload.eventsPath)), error => error.code === 'ENOENT');

  const failingRuntime = createCodexCliRuntime({ resolveProject: id => fixture.harness.projectRegistry.get(id), runtimeRoot: fixture.dataRoot, spawnProcess: () => { throw new Error('synthetic spawn failure'); } });
  await assert.rejects(() => failingRuntime.spawn({ projectId: fixture.projectId, dispatchId: 'failed-spawn', feature: { id: 'probe', allowedPaths: ['src'], forbiddenPaths: [] } }), /synthetic spawn failure/);
  await assert.rejects(() => access(resolve(fixture.dataRoot, 'runtime', 'codex-cli')), error => error.code === 'ENOENT');
});

test('Codex CLI Runtime preserves startup failure evidence instead of reporting only a missing result file', async t => {
  const fixture = await makeFixture({ policy: { runtimePlugins: ['codex-cli-runtime'], defaultRuntimePlugin: 'codex-cli-runtime', runtimeConfigs: { 'codex-cli-runtime': { sandbox: 'workspace-write', approveForMe: true } } } });
  t.after(() => fixture.cleanup());
  const runtime = createCodexCliRuntime({
    resolveProject: id => fixture.harness.projectRegistry.get(id),
    runtimeRoot: fixture.dataRoot,
    executable: process.execPath,
    executableArgs: ['-e', "process.stderr.write('synthetic Codex CLI startup failure'); process.exitCode = 2;"],
  });
  const spawned = await runtime.spawn({ projectId: fixture.projectId, dispatchId: 'dispatch-startup-failure', feature: { id: 'probe', allowedPaths: ['src'], forbiddenPaths: [] } });
  const waited = await runtime.wait({ agentId: spawned.payload.agentId });
  assert.equal(waited.payload.status, 'failed');
  assert.equal(waited.payload.startupError.code, 'CODEX_CLI_STARTUP_FAILED');
  assert.equal(waited.payload.resultError.code, 'ENOENT');
  assert.equal(waited.payload.sandboxReceipt.applied, false);
  assert.equal(waited.payload.sandboxReceipt.requested, true);
  const business = businessResultFromRuntime(waited.payload);
  assert.equal(business.failureClass, 'runtime-startup');
  assert.match(business.summary, /exited before starting/);
  await runtime.cleanup({ agentId: spawned.payload.agentId });
});

test('Codex CLI Runtime surfaces provider schema failures ahead of missing result.json', async t => {
  const fixture = await makeFixture({ policy: { runtimePlugins: ['codex-cli-runtime'], defaultRuntimePlugin: 'codex-cli-runtime', runtimeConfigs: { 'codex-cli-runtime': { sandbox: 'workspace-write', approveForMe: true } } } });
  t.after(() => fixture.cleanup());
  const event = `${JSON.stringify({ type: 'thread.started', thread_id: 'provider-thread' })}\n${JSON.stringify({ type: 'error', message: JSON.stringify({ error: { message: 'Invalid schema for response_format', type: 'invalid_request_error', param: 'text.format.schema', code: 'invalid_json_schema' } }) })}`;
  const runtime = createCodexCliRuntime({
    resolveProject: id => fixture.harness.projectRegistry.get(id),
    runtimeRoot: fixture.dataRoot,
    executable: process.execPath,
    executableArgs: ['-e', `process.stdout.write(${JSON.stringify(event + '\n')}); process.exitCode = 1;`],
  });
  const spawned = await runtime.spawn({ projectId: fixture.projectId, dispatchId: 'dispatch-provider-failure', feature: { id: 'probe', allowedPaths: ['src'], forbiddenPaths: [] } });
  const waited = await runtime.wait({ agentId: spawned.payload.agentId });
  assert.equal(waited.payload.providerError.code, 'CODEX_OUTPUT_SCHEMA_INVALID');
  assert.equal(waited.payload.providerError.failureClass, 'runtime-contract');
  assert.equal(waited.payload.resultError.code, 'ENOENT');
  assert.ok(waited.payload.stdout.includes('invalid_json_schema'));
  const business = businessResultFromRuntime(waited.payload);
  assert.equal(business.failureClass, 'runtime-contract');
  assert.equal(business.blocker.code, 'CODEX_OUTPUT_SCHEMA_INVALID');
  assert.match(business.summary, /Invalid schema/);
  await runtime.cleanup({ agentId: spawned.payload.agentId });
});
