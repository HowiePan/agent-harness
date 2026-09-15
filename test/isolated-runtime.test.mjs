import assert from 'node:assert/strict';
import test from 'node:test';
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunCoordinator } from '../src/index.mjs';
import { extensionPack as codexRuntimeExtension } from '../src/extensions/codex-headless-runtime.mjs';
import { feature, makeFixture, startRun } from './test-support.mjs';

const probe = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'isolated-codex-probe.mjs');

test('isolated Codex Runtime executes and safely integrates ten game Features in physical parallel', async t => {
  const runtime = 'codex-isolated-runtime';
  const fixture = await makeFixture({ extensions: [codexRuntimeExtension], allowedPluginPermissions: ['state.write', 'agent.conversation', 'process.spawn', 'workspace.read', 'workspace.write', 'gate.execute', 'artifact.read'], policy: { runtimePlugins: [runtime], defaultRuntimePlugin: runtime, maxConcurrency: 10, runtimeConfigs: { [runtime]: { executable: process.execPath, executableArgs: [probe], linkedDirectories: [], sandbox: 'workspace-write', approveForMe: true } } } });
  t.after(() => fixture.cleanup());
  const features = Array.from({ length: 10 }, (_, index) => feature(`game-${index + 1}`, {}, { laneId: `game-${index + 1}`, allowedPaths: [`work/game-${index + 1}.txt`] }));
  await startRun(fixture, { features });
  const tick = await new RunCoordinator({ harness: fixture.harness }).tick({ projectId: fixture.projectId, runId: 'run', maxConcurrency: 10 });
  assert.equal(tick.status, 'progressed');
  assert.equal(tick.physicalLimit, 10);
  assert.equal(tick.committed.length, 10);
  assert.equal(tick.committed.every(item => item.runtimeReceipt.payload.events[0].temp.startsWith(fixture.dataRoot)), true);
  assert.equal(tick.committed.every(item => item.runtimeReceipt.payload.events[0].args.includes('--approve-for-me')), true);
  assert.equal(tick.committed.every(item => !item.runtimeReceipt.payload.events[0].args.includes('--sandbox')), true);
  assert.equal(tick.committed.every(item => item.runtimeReceipt.payload.sandboxReceipt.applied === true), true);
  assert.equal(tick.committed.every(item => item.cleanupReceipt.payload.outputReceipt.status === 'cleaned'), true);
  const evidence = await fixture.harness.evidenceStore.read(tick.state.submissions[0].evidenceRefs[0]);
  const evidenceValue = JSON.parse(evidence.bytes.toString('utf8'));
  assert.equal(evidenceValue.runtimeEvidence.cleanup.payload.outputReceipt.receiptDigest, tick.committed[0].cleanupReceipt.payload.outputReceipt.receiptDigest);
  for (const feature of features) assert.equal(await readFile(resolve(fixture.workspace, feature.allowedPaths[0]), 'utf8'), `${feature.id}\n`);
  assert.equal(tick.state.features.every(item => item.state === 'completed'), true);
  await assert.rejects(() => access(resolve(fixture.dataRoot, 'runtime', 'codex-cli')), error => error.code === 'ENOENT');
});

test('isolated Runtime discards invalid output and removes debug directories on the failure path', async t => {
  const runtime = 'codex-isolated-runtime';
  const fixture = await makeFixture({ extensions: [codexRuntimeExtension], allowedPluginPermissions: ['state.write', 'agent.conversation', 'process.spawn', 'workspace.read', 'workspace.write', 'gate.execute', 'artifact.read'], policy: { runtimePlugins: [runtime], defaultRuntimePlugin: runtime, runtimeConfigs: { [runtime]: { executable: process.execPath, executableArgs: [probe], linkedDirectories: [] } } } });
  t.after(() => fixture.cleanup());
  await startRun(fixture, { features: [feature('invalid-claim', { omitChangedFiles: true }, { allowedPaths: ['work/invalid-claim.txt'] })] });
  const tick = await new RunCoordinator({ harness: fixture.harness }).tick({ projectId: fixture.projectId, runId: 'run', maxConcurrency: 1 });
  assert.equal(tick.committed[0].status, 'blocked');
  await assert.rejects(() => readFile(resolve(fixture.workspace, 'work', 'invalid-claim.txt')), error => error.code === 'ENOENT');
  await assert.rejects(() => access(resolve(fixture.dataRoot, 'runtime', 'codex-cli')), error => error.code === 'ENOENT');
});
