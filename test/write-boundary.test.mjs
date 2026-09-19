import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { access, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { assertHarnessWritePath, AuthorityStore, computeAuthorityDigest, createHarness, defaultDataRoot, digestJson, EvidenceStore, GateCache, harnessControlRoot, harnessProjectRoot, harnessTemporaryRoot, loadReleaseIdentity, ProjectRegistry, sha256, temporaryEnvironment, verifyReleaseManifest } from '../src/index.mjs';
import { createCodexCliRuntime } from '../integrations/codex/runtime/codex-cli-runtime.mjs';

const executeFile = promisify(execFile);

test('all Harness-controlled write roots stay inside the standalone control root', async () => {
  const projectRoot = harnessProjectRoot();
  assert.equal(harnessControlRoot(), projectRoot);
  if (process.platform === 'win32') assert.throws(() => harnessControlRoot('C:\\agent-harness-forbidden'), error => error.code === 'HARNESS_SYSTEM_DRIVE_FORBIDDEN');
  assert.ok(defaultDataRoot().startsWith(`${projectRoot}\\`) || defaultDataRoot().startsWith(`${projectRoot}/`));
  assert.ok(harnessTemporaryRoot().startsWith(`${projectRoot}\\`) || harnessTemporaryRoot().startsWith(`${projectRoot}/`));
  const forbidden = resolve(projectRoot, '..', 'agent-harness-outside-write-probe');
  await assert.rejects(() => createHarness({ dataRoot: forbidden }), error => error.code === 'HARNESS_WRITE_OUTSIDE_PROJECT');
  for (const construct of [
    () => new AuthorityStore({ root: forbidden }),
    () => new EvidenceStore({ root: forbidden }),
    () => new GateCache({ root: forbidden }),
    () => new ProjectRegistry({ root: forbidden }),
    () => createCodexCliRuntime({ resolveProject: async () => null, runtimeRoot: forbidden }),
  ]) assert.throws(construct, error => error.code === 'HARNESS_WRITE_OUTSIDE_PROJECT');
  await assert.rejects(() => access(forbidden), error => error.code === 'ENOENT');
  const environment = temporaryEnvironment(resolve(projectRoot, '.tmp', 'environment-probe'));
  assert.equal(environment.TEMP, environment.TMP);
  assert.equal(environment.TEMP, environment.TMPDIR);
  assert.ok(environment.TEMP.startsWith(projectRoot));
});

test('managed write paths reject symbolic links and Windows junctions', async t => {
  const temporaryRoot = harnessTemporaryRoot();
  const probeRoot = resolve(temporaryRoot, 'link-boundary-test');
  const link = resolve(probeRoot, 'outside-link');
  await mkdir(probeRoot, { recursive: true });
  t.after(async () => { await rm(link, { force: true }); await rm(probeRoot, { recursive: true, force: true }); });
  await symlink(resolve(harnessProjectRoot(), '..'), link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(
    () => assertHarnessWritePath(resolve(link, 'escaped-output'), 'junction probe'),
    error => ['PATH_OUTSIDE_ROOT', 'MANAGED_PATH_LINK_FORBIDDEN'].includes(error.code),
  );
});

test('Harness release verification rejects artifact files reached through a junction', async t => {
  const probeRoot = resolve(harnessTemporaryRoot(), 'release-link-test');
  const releaseRoot = resolve(probeRoot, 'release');
  const outside = resolve(probeRoot, 'outside');
  await mkdir(releaseRoot, { recursive: true });
  await mkdir(outside, { recursive: true });
  t.after(() => rm(probeRoot, { recursive: true, force: true }));
  const payload = Buffer.from('outside release payload\n');
  await writeFile(resolve(outside, 'payload.txt'), payload);
  await symlink(outside, resolve(releaseRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const files = [{ path: 'linked/payload.txt', sha256: sha256(payload), size: payload.length }];
  await writeFile(resolve(releaseRoot, 'release-manifest.json'), `${JSON.stringify({ protocolVersion: '1.0', version: '1.0.0', files, packageDigest: digestJson(files) })}\n`, 'utf8');
  await assert.rejects(
    () => verifyReleaseManifest({ root: releaseRoot }),
    error => ['PATH_OUTSIDE_ROOT', 'MANAGED_PATH_LINK_FORBIDDEN'].includes(error.code),
  );
});

test('release identity is discovered and verified from the packaged manifest', async () => {
  const identity = await loadReleaseIdentity();
  assert.equal(identity.version, '1.0.0');
  assert.match(identity.artifactDigest, /^[a-f0-9]{64}$/);
  assert.equal(identity.verified, true);
});

test('doctor validates the write boundary without creating its data root', async () => {
  const projectRoot = harnessProjectRoot();
  const target = resolve(projectRoot, '.tmp', `doctor-no-write-${process.pid}`);
  await assert.rejects(() => access(target), error => error.code === 'ENOENT');
  const { stdout } = await executeFile(process.execPath, [resolve(projectRoot, 'bin', 'agent-harness.mjs'), 'doctor', '--data-root', target], { cwd: projectRoot, windowsHide: true });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.initialized, false);
  assert.equal(result.lifecycleReady, false);
  assert.equal(result.writeCapability, 'not-probed');
  assert.deepEqual(result.paths, { dataRoot: false, extensionRegistry: false, projectRegistry: false, authority: false });
  assert.equal(result.dataRoot, target);
  await assert.rejects(() => access(target), error => error.code === 'ENOENT');
});

test('project list is read-only when the data root does not exist', async () => {
  const projectRoot = harnessProjectRoot();
  const target = resolve(projectRoot, '.tmp', `project-list-no-write-${process.pid}`);
  await assert.rejects(() => access(target), error => error.code === 'ENOENT');
  const { stdout } = await executeFile(process.execPath, [resolve(projectRoot, 'bin', 'agent-harness.mjs'), 'project', 'list', '--data-root', target], { cwd: projectRoot, windowsHide: true });
  assert.deepEqual(JSON.parse(stdout), { ok: true, projects: [] });
  await assert.rejects(() => access(target), error => error.code === 'ENOENT');
});

test('run status fails without initializing a missing data root', async () => {
  const projectRoot = harnessProjectRoot();
  const target = resolve(projectRoot, '.tmp', `run-status-no-write-${process.pid}`);
  await assert.rejects(() => access(target), error => error.code === 'ENOENT');
  await assert.rejects(
    () => executeFile(process.execPath, [resolve(projectRoot, 'bin', 'agent-harness.mjs'), 'run', 'status', '--project', 'missing', '--run', 'missing', '--data-root', target], { cwd: projectRoot, windowsHide: true }),
    error => /RUN_NOT_FOUND/.test(error.stderr),
  );
  await assert.rejects(() => access(target), error => error.code === 'ENOENT');
});

test('project list and run status do not import registered Extension code', async t => {
  const projectRoot = harnessProjectRoot();
  const target = resolve(projectRoot, '.tmp', `read-only-no-extension-import-${process.pid}`);
  t.after(() => rm(target, { recursive: true, force: true }));
  const registryDirectory = resolve(target, 'registry');
  await mkdir(resolve(registryDirectory, 'projects'), { recursive: true });
  const extension = { id: 'side-effect-probe', version: '1.0.0', digest: 'a'.repeat(64), entry: 'missing-side-effect-probe.mjs', registeredAt: '2026-09-13T00:00:00.000Z' };
  const registryBody = { protocolVersion: '1.0', revision: 1, extensions: [extension], commands: {} };
  await writeFile(resolve(registryDirectory, 'extensions.json'), `${JSON.stringify({ ...registryBody, registryDigest: digestJson(registryBody) })}\n`, 'utf8');
  const listed = await executeFile(process.execPath, [resolve(projectRoot, 'bin', 'agent-harness.mjs'), 'project', 'list', '--data-root', target], { cwd: projectRoot, windowsHide: true });
  assert.deepEqual(JSON.parse(listed.stdout), { ok: true, projects: [] });
  const stateBody = { projectId: 'project', runId: 'run', profile: { id: 'side-effect-profile' }, revision: 1, commands: {} };
  const state = { ...stateBody, authorityDigest: computeAuthorityDigest(stateBody) };
  const authorityFile = resolve(target, 'authority', 'project', 'run', 'run.json');
  await mkdir(resolve(authorityFile, '..'), { recursive: true });
  await writeFile(authorityFile, `${JSON.stringify(state)}\n`, 'utf8');
  const status = JSON.parse((await executeFile(process.execPath, [resolve(projectRoot, 'bin', 'agent-harness.mjs'), 'run', 'status', '--project', 'project', '--run', 'run', '--data-root', target], { cwd: projectRoot, windowsHide: true })).stdout);
  assert.equal(status.authority.authorityDigest, state.authorityDigest);
  assert.equal(status.projection, null);
});

test('doctor reports lifecycle readiness only when all persisted roots and registries exist', async t => {
  const projectRoot = harnessProjectRoot();
  const target = resolve(projectRoot, '.tmp', `doctor-ready-${process.pid}`);
  t.after(() => rm(target, { recursive: true, force: true }));
  const registryDirectory = resolve(target, 'registry');
  const projectDirectory = resolve(registryDirectory, 'projects');
  await Promise.all([mkdir(projectDirectory, { recursive: true }), mkdir(resolve(target, 'authority'), { recursive: true })]);
  const exactDigest = (await loadReleaseIdentity()).artifactDigest;
  const extensionBody = { protocolVersion: '1.0', revision: 0, extensions: [], commands: {} };
  await writeFile(resolve(registryDirectory, 'extensions.json'), `${JSON.stringify({ ...extensionBody, registryDigest: digestJson(extensionBody) })}\n`, 'utf8');
  const descriptorInput = { id: 'fixture-project', harness: { version: '1.0.0', artifactDigest: exactDigest }, workspace: { root: resolve(projectRoot, 'test') }, profiles: ['feature-delivery'], extensions: [], policy: { agentExecutionMode: 'headless', defaultRuntimePlugin: 'fixture-runtime', runtimePlugins: ['fixture-runtime'], promptCodecPlugin: 'reference-agent-prompt-codec' }, gateRecipes: [], artifactProviders: [] };
  const commandReceipt = { commandId: 'fixture-register', payloadDigest: digestJson(descriptorInput), revision: 1, committedAt: '2026-09-13T00:00:00.000Z', authorityDecision: null };
  const descriptorBody = { ...descriptorInput, protocolVersion: '1.0', revision: 1, updatedAt: '2026-09-13T00:00:00.000Z', commands: { 'fixture-register': commandReceipt } };
  await writeFile(resolve(projectDirectory, 'fixture-project.json'), `${JSON.stringify({ ...descriptorBody, descriptorDigest: digestJson(descriptorBody) })}\n`, 'utf8');
  const { stdout } = await executeFile(process.execPath, [resolve(projectRoot, 'bin', 'agent-harness.mjs'), 'doctor', '--data-root', target], { cwd: projectRoot, windowsHide: true });
  const result = JSON.parse(stdout);
  assert.equal(result.initialized, true);
  assert.equal(result.registryReady, true);
  assert.equal(result.lifecycleReady, false);
  assert.deepEqual(result.paths, { dataRoot: true, extensionRegistry: true, projectRegistry: true, authority: true });
  assert.deepEqual(result.registeredProjects.map(project => project.id), ['fixture-project']);
});
