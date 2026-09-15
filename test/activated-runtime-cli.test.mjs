import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { harnessTemporaryRoot } from '../src/write-boundary.mjs';

const execFile = promisify(execFileCallback);

test('activated immutable runtime CLI can use its parent standalone control root', async t => {
  const sourceRoot = resolve(process.cwd());
  const tempParent = resolve(harnessTemporaryRoot(), 'activated-runtime-cli-tests');
  await mkdir(tempParent, { recursive: true });
  const root = await mkdtemp(resolve(tempParent, 'runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const controlRoot = resolve(root, 'control');
  const dataRoot = resolve(controlRoot, '.agent-harness-data');
  const workspaceRoot = resolve(root, 'CardWorld');
  const manifest = JSON.parse(await readFile(resolve(sourceRoot, 'release-manifest.json'), 'utf8'));
  for (const item of manifest.files) {
    const target = resolve(controlRoot, item.path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(resolve(sourceRoot, item.path), target);
  }
  for (const name of manifest.metadataFiles ?? ['release-manifest.json', 'sbom.spdx.json']) {
    await copyFile(resolve(sourceRoot, name), resolve(controlRoot, name));
  }
  await mkdir(resolve(workspaceRoot, '.git'), { recursive: true });
  await writeFile(resolve(workspaceRoot, 'README.md'), 'fixture\n', 'utf8');

  const api = await import(pathToFileURL(resolve(controlRoot, 'src', 'index.mjs')).href);
  const consumer = await import(pathToFileURL(resolve(controlRoot, 'src', 'consumers', 'cardworld-engine.mjs')).href);
  const releaseIdentity = await api.loadReleaseIdentity({ root: controlRoot });
  const extensions = new api.ExtensionRegistry({ controlRoot, dataRoot });
  const profile = await extensions.register(resolve(controlRoot, 'src', 'consumers', 'cardworld-engine.mjs'), { expectedRevision: 0, commandId: 'profile', authorityDecision: { actor: 'test', decision: 'approved' } });
  const runtime = await extensions.register(resolve(controlRoot, 'src', 'extensions', 'codex-runtime.mjs'), { expectedRevision: 1, commandId: 'runtime', authorityDecision: { actor: 'test', decision: 'approved' } });
  const projects = new api.ProjectRegistry({ root: dataRoot, controlRoot });
  const descriptor = consumer.createCardWorldProjectDescriptor({ workspaceRoot, harness: { version: releaseIdentity.version, artifactDigest: releaseIdentity.artifactDigest } });
  descriptor.extensions = descriptor.extensions.map(item => ({ ...item, digest: item.id === profile.id ? profile.digest : runtime.digest }));
  await projects.register(descriptor, { expectedRevision: 0, commandId: 'project' });
  await new api.AuthorityStore({ root: dataRoot, controlRoot }).init();

  const plan = await api.createReleaseActivationPlan({ controlRoot, dataRoot, releaseIdentity });
  const applied = await api.applyReleaseActivationPlan(plan, {
    controlRoot,
    dataRoot,
    releaseIdentity,
    commandId: 'activate',
    authorityDecision: { actor: 'test', decision: 'approved', action: 'release-activation', context: { planDigest: plan.planDigest } },
    activateInstallation: true,
  });
  const { stdout } = await execFile(process.execPath, [applied.runtimeEntrypoint, 'doctor', '--control-root', controlRoot, '--data-root', dataRoot, '--project', 'cardworld-engine', '--profile', 'engine-delivery', '--extension-id', 'cardworld-engine-profile', '--execution-workspace', workspaceRoot], { cwd: controlRoot, windowsHide: true });
  const doctor = JSON.parse(stdout);
  assert.equal(doctor.ok, true);
  assert.equal(doctor.controlRootMode, 'installed');
  assert.equal(doctor.registryReady, true);
  assert.equal(doctor.projectReadiness[0].projectReady, true);
});
