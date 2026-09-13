import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { applyBootstrapPlan, createBootstrapPlan, harnessProjectRoot, harnessTemporaryRoot, inspectLifecycleReadiness, loadReleaseIdentity } from '../src/index.mjs';

test('bootstrap plan is zero-write and apply is approved, idempotent, and project-scoped', async t => {
  const controlRoot = harnessProjectRoot();
  const parent = resolve(harnessTemporaryRoot(), 'bootstrap-tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'case-'));
  const workspaceRoot = resolve(root, 'CardWorld');
  const dataRoot = resolve(root, 'data');
  await mkdir(resolve(workspaceRoot, '.git'), { recursive: true });
  await writeFile(resolve(workspaceRoot, 'README.md'), 'fixture\n', 'utf8');
  t.after(() => rm(root, { recursive: true, force: true }));
  const releaseIdentity = await loadReleaseIdentity();
  const request = {
    protocolVersion: '1.0',
    extensions: [
      { id: 'cardworld-engine-profile', version: '1.0.0', module: 'agent-harness/consumers/cardworld-engine' },
      { id: 'codex-runtime', version: '1.0.0', module: 'agent-harness/extensions/codex-runtime' },
    ],
    project: { generatorExtensionId: 'cardworld-engine-profile', input: { id: 'cardworld-engine', workspaceRoot, maxConcurrency: 1 } },
    binding: { projectId: 'cardworld-engine', profileId: 'engine-delivery', extensionId: 'cardworld-engine-profile', workspaceRoot },
  };
  const plan = await createBootstrapPlan(request, { controlRoot, dataRoot, releaseIdentity });
  assert.match(plan.planDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(plan.extensions.map(item => item.action), ['register', 'register']);
  await assert.rejects(() => access(dataRoot), error => error.code === 'ENOENT');
  const decision = { actor: 'project-owner', decision: 'approved', action: 'bootstrap' };
  const applied = await applyBootstrapPlan(plan, { controlRoot, dataRoot, releaseIdentity, commandId: 'bootstrap-engine', authorityDecision: decision });
  assert.equal(applied.receipt.status, 'committed');
  assert.equal(applied.receipt.readiness.lifecycleReady, true);
  const repeated = await applyBootstrapPlan(plan, { controlRoot, dataRoot, releaseIdentity, commandId: 'bootstrap-engine', authorityDecision: decision });
  assert.equal(repeated.reused, true);
  const missing = await inspectLifecycleReadiness({ controlRoot, dataRoot, releaseIdentity, projectId: 'tabletop-collection', profileId: 'collection-batch', extensionId: 'tabletop-collection-profile' });
  assert.equal(missing.lifecycleReady, false);
  assert.equal(missing.projectReadiness[0].issues[0].code, 'PROJECT_NOT_REGISTERED');
});
