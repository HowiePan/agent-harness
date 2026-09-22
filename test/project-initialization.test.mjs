import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { applyProjectInitializationPlan, createProjectInitializationPlan, harnessProjectRoot, harnessTemporaryRoot, loadProjectHarnessConfig } from '../src/index.mjs';

test('project-owned harness.json compiles to an approved source-link initialization receipt', async t => {
  const controlRoot = harnessProjectRoot();
  const parent = resolve(harnessTemporaryRoot(), 'project-initialization-tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'case-'));
  const projectRoot = resolve(root, 'consumer');
  const dataRoot = resolve(root, 'control-data');
  await mkdir(resolve(projectRoot, '.git'), { recursive: true });
  await writeFile(resolve(projectRoot, 'README.md'), 'consumer fixture\n');
  const configPath = resolve(projectRoot, 'harness.json');
  const config = {
    schemaVersion: '1.0', kind: 'agent-harness-project',
    extensions: [
      { id: 'delivery-lifecycle-profile', version: '1.0.0', module: 'agent-harness/consumers/delivery-lifecycle' },
      { id: 'codex-runtime', version: '1.0.0', module: 'agent-harness/extensions/codex-runtime' },
    ],
    project: { generatorExtensionId: 'delivery-lifecycle-profile', input: { gateRecipes: [] } },
    binding: { alias: 'consumer', projectId: 'consumer', profileId: 'delivery-lifecycle', extensionId: 'delivery-lifecycle-profile', workspaceRoot: '.' },
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  t.after(() => rm(root, { recursive: true, force: true }));

  const loaded = await loadProjectHarnessConfig(configPath, { projectRoot });
  assert.equal(loaded.request.binding.workspaceRoot, projectRoot);
  const releaseIdentity = { version: '1.0.0', artifactDigest: 'd'.repeat(64), verified: true, development: true };
  const plan = await createProjectInitializationPlan(configPath, { projectRoot, controlRoot, dataRoot, releaseIdentity, mode: 'source-link' });
  const output = await applyProjectInitializationPlan(plan, { controlRoot, dataRoot, releaseIdentity, commandId: 'source-init', authorityDecision: { actor: 'project-owner', decision: 'approved', action: 'project-init' } });
  assert.equal(output.receipt.mode, 'source-link');
  assert.equal(output.receipt.hostBinding.projectId, 'consumer');
  assert.deepEqual(output.receipt.hostBinding.workflows.map(item => item.id), ['delivery-lifecycle']);
  assert.match(output.receipt.receiptDigest, /^[a-f0-9]{64}$/);
});

test('project initialization plan is invalidated when harness.json changes', async t => {
  const controlRoot = harnessProjectRoot();
  const parent = resolve(harnessTemporaryRoot(), 'project-initialization-tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'drift-'));
  const projectRoot = resolve(root, 'consumer');
  await mkdir(projectRoot, { recursive: true });
  const configPath = resolve(projectRoot, 'harness.json');
  const config = { schemaVersion: '1.0', kind: 'agent-harness-project', extensions: [{ id: 'delivery-lifecycle-profile', version: '1.0.0', module: 'agent-harness/consumers/delivery-lifecycle' }], project: { generatorExtensionId: 'delivery-lifecycle-profile', input: {} }, binding: { projectId: 'consumer', profileId: 'delivery-lifecycle', extensionId: 'delivery-lifecycle-profile', workspaceRoot: '.' } };
  await writeFile(configPath, JSON.stringify(config));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plan = await createProjectInitializationPlan(configPath, { projectRoot, controlRoot, dataRoot: resolve(root, 'data'), releaseIdentity: { version: '1.0.0', artifactDigest: 'e'.repeat(64), verified: true }, mode: 'source-link' });
  await writeFile(configPath, `${JSON.stringify(config)}\n`);
  await assert.rejects(() => applyProjectInitializationPlan(plan, { controlRoot, dataRoot: resolve(root, 'data'), releaseIdentity: { version: '1.0.0', artifactDigest: 'e'.repeat(64), verified: true }, commandId: 'changed', authorityDecision: { actor: 'owner', decision: 'approved' } }), error => error.code === 'PROJECT_INIT_CONFIG_CHANGED');
});
