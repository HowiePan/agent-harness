import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { access, mkdir } from 'node:fs/promises';
import { createCodexCliRuntime } from '../src/plugins/runtime/codex-cli-runtime.mjs';
import { makeFixture } from './test-support.mjs';

test('Codex CLI Runtime uses non-interactive structured output and records transport evidence', async t => {
  const fixture = await makeFixture({ policy: { runtimePlugins: ['codex-cli-runtime'], defaultRuntimePlugin: 'codex-cli-runtime', runtimeConfigs: { 'codex-cli-runtime': { sandbox: 'workspace-write' } } } });
  t.after(() => fixture.cleanup());
  const runtime = createCodexCliRuntime({ resolveProject: id => fixture.harness.projectRegistry.get(id), runtimeRoot: fixture.dataRoot, executable: process.execPath, executableArgs: [resolve('test/fixtures/codex-cli-probe.mjs')] });
  const executionWorkspace = resolve(fixture.root, 'execution-workspace');
  await mkdir(executionWorkspace, { recursive: true });
  const spawned = await runtime.spawn({ projectId: fixture.projectId, dispatchId: 'dispatch-probe', workspace: { root: executionWorkspace }, feature: { id: 'probe', allowedPaths: ['src'], forbiddenPaths: [] } });
  assert.equal(spawned.payload.transportReceipt.workspaceRoot, executionWorkspace);
  const waited = await runtime.wait({ agentId: spawned.payload.agentId });
  assert.equal(waited.payload.status, 'completed');
  assert.equal(waited.payload.result.status, 'completed');
  assert.equal(waited.payload.threadId, 'probe-thread');
  assert.ok(waited.payload.events[0].temp.startsWith(fixture.dataRoot));
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
