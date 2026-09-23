import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { applyProjectInitializationPlan, createProjectInitializationPlan, harnessProjectRoot, harnessTemporaryRoot, verifyDevelopmentSourceManifest, writeDevelopmentSourceManifest } from '../src/index.mjs';
import { validateActiveReleaseBinding } from '../integrations/codex/agent-harness-codex/lib/active-release-binding.mjs';

const execFileAsync = promisify(execFile);

test('development source manifest lets Codex bind exact source and rejects stale identities', async t => {
  const controlRoot = harnessProjectRoot();
  const parent = resolve(harnessTemporaryRoot(), 'development-binding-tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'case-'));
  const projectRoot = resolve(root, 'consumer');
  const dataRoot = resolve(root, 'data');
  await mkdir(projectRoot, { recursive: true });
  const configPath = resolve(projectRoot, 'harness.json');
  await writeFile(configPath, '{}\n');
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = await writeDevelopmentSourceManifest({ bindingId: 'consumer', sourceRoot: controlRoot, controlRoot, dataRoot, configPath, projectRoot });
  const verified = await verifyDevelopmentSourceManifest(output.file);
  assert.equal(verified.releaseIdentity.development, true);
  const active = await validateActiveReleaseBinding({ controlRoot, dataRoot, entrypoint: output.manifest.entrypoint, declaredRelease: { ...output.manifest.release, developmentManifest: output.file } });
  assert.equal(active.mode, 'source-link');
  assert.equal(active.artifactDigest, output.manifest.release.artifactDigest);
  await assert.rejects(() => validateActiveReleaseBinding({ controlRoot, dataRoot, entrypoint: output.manifest.entrypoint, declaredRelease: { ...output.manifest.release, artifactDigest: '0'.repeat(64), developmentManifest: output.file } }), /已过期/);
});

test('development manifest enables read-only workflow planning and fails closed without a visible host', async t => {
  const controlRoot = harnessProjectRoot();
  const parent = resolve(harnessTemporaryRoot(), 'development-binding-tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = resolve(root, 'consumer');
  const dataRoot = resolve(root, 'data');
  await mkdir(resolve(projectRoot, '.git'), { recursive: true });
  await writeFile(resolve(projectRoot, 'README.md'), 'synthetic source-link fixture\n');
  const configPath = resolve(projectRoot, 'harness.json');
  await writeFile(configPath, JSON.stringify({
    schemaVersion: '1.0', kind: 'agent-harness-project',
    extensions: [
      { id: 'delivery-lifecycle-profile', version: '1.0.0', module: 'agent-harness/consumers/delivery-lifecycle' },
      { id: 'codex-runtime', version: '1.0.0', module: 'agent-harness/extensions/codex-runtime' },
    ],
    project: { generatorExtensionId: 'delivery-lifecycle-profile', input: { gateRecipes: [] } },
    binding: { alias: 'local-debug-fixture', projectId: 'local-debug-fixture', profileId: 'delivery-lifecycle', extensionId: 'delivery-lifecycle-profile', workspaceRoot: '.' },
  }));
  const source = await writeDevelopmentSourceManifest({ bindingId: 'local-debug-fixture', sourceRoot: controlRoot, controlRoot, dataRoot, configPath, projectRoot });
  const releaseIdentity = { version: source.manifest.release.version, artifactDigest: source.manifest.release.artifactDigest, verified: true, development: true };
  const initPlan = await createProjectInitializationPlan(configPath, { projectRoot, controlRoot, dataRoot, releaseIdentity, mode: 'source-link' });
  const initialized = await applyProjectInitializationPlan(initPlan, { controlRoot, dataRoot, releaseIdentity, commandId: 'local-debug-test-init', authorityDecision: { actor: 'synthetic-test', decision: 'approved', action: 'project-init' } });
  assert.equal(initialized.receipt.bootstrapReceipt.readiness.registryReady, true);

  const cli = async args => JSON.parse((await execFileAsync(process.execPath, [resolve(controlRoot, 'bin', 'agent-harness.mjs'), ...args, '--development-manifest', source.file], { cwd: controlRoot })).stdout);
  const listed = await cli(['workflow', 'list', '--project', 'local-debug-fixture']);
  assert.equal(listed.workflows[0].id, 'delivery-lifecycle');
  const inputFile = resolve(root, 'quality-input.json');
  await writeFile(inputFile, JSON.stringify({ projectId: 'local-debug-fixture', action: 'quality', target: 'synthetic-v1', arguments: ['review-only'], extensionId: 'delivery-lifecycle-profile', executionWorkspaceRoot: projectRoot }));
  const planned = await cli(['lifecycle', 'plan', '--input', inputFile]);
  assert.equal(planned.plan.run.agentExecutionMode, 'conversation-visible');
  const planFile = resolve(root, 'quality-plan.json');
  await writeFile(planFile, JSON.stringify(planned.plan));
  const preflight = await cli(['lifecycle', 'preflight', '--plan', planFile]);
  assert.equal(preflight.report.executionReady, false);
  assert.equal(preflight.report.checks.find(check => check.id === 'visible-host').issues[0].code, 'VISIBLE_AGENT_HOST_COORDINATOR_UNAVAILABLE');
  await assert.rejects(
    () => execFileAsync(process.execPath, [resolve(controlRoot, 'bin', 'agent-harness.mjs'), 'lifecycle', 'start', '--plan', planFile, '--development-manifest', source.file], { cwd: controlRoot }),
    error => error.stderr.includes('DEVELOPMENT_MANIFEST_COMMAND_UNSUPPORTED'),
  );
});
