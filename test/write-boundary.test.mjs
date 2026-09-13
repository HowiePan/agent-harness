import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { access, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { assertHarnessWritePath, AuthorityStore, createHarness, defaultDataRoot, digestJson, EvidenceStore, GateCache, harnessControlRoot, harnessProjectRoot, harnessTemporaryRoot, loadReleaseIdentity, ProjectRegistry, sha256, temporaryEnvironment, verifyReleaseManifest } from '../src/index.mjs';
import { createCodexCliRuntime } from '../src/plugins/runtime/codex-cli-runtime.mjs';

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
  const { stdout } = await executeFile(process.execPath, [resolve(projectRoot, 'src', 'cli.mjs'), 'doctor', '--data-root', target], { cwd: projectRoot, windowsHide: true });
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.initialized, false);
  assert.equal(result.dataRoot, target);
  await assert.rejects(() => access(target), error => error.code === 'ENOENT');
});
