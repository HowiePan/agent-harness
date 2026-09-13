import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../src/canonical.mjs';
import { assert } from '../src/errors.mjs';
import { sealReleaseCandidateReceipt } from '../src/maintenance/release-receipt.mjs';
import { assertNoLinkPath } from '../src/paths.mjs';
import { verifyReleaseManifest } from '../src/release-identity.mjs';
import { assertHarnessWritePath, temporaryEnvironment } from '../src/write-boundary.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratchRoot = assertHarnessWritePath(resolve(root, '.tmp', 'release-candidate'), 'release candidate scratch root', root);
const npmCache = assertHarnessWritePath(resolve(root, '.agent-harness-cache', 'npm'), 'release candidate npm cache', root);
const releaseRoot = assertHarnessWritePath(resolve(root, '.agent-harness-data', 'release-candidates'), 'release candidate output root', root);
const npmCli = process.env.npm_execpath;
assert(npmCli, 'NPM_EXECUTABLE_REQUIRED', 'build:release-candidate must be started through npm.');

const run = (executable, args, { cwd = root, environment = {}, inherit = false } = {}) => new Promise((resolveRun, reject) => {
  const child = spawn(executable, args, {
    cwd,
    env: { ...process.env, ...environment },
    windowsHide: true,
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  if (!inherit) {
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
  }
  child.on('error', reject);
  child.on('close', (exitCode, signal) => {
    if (exitCode === 0 && !signal) resolveRun({ stdout, stderr });
    else reject(Object.assign(new Error(`${executable} exited with ${signal ?? exitCode}: ${stderr.trim()}`), { code: 'RELEASE_CANDIDATE_COMMAND_FAILED', exitCode, signal }));
  });
});

const inside = (parent, child) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

const validateSkills = async packageRoot => {
  const pluginRoot = assertNoLinkPath(packageRoot, resolve(packageRoot, 'integrations', 'codex', 'agent-harness-codex'), 'packaged Codex plugin');
  const manifest = JSON.parse(await readFile(resolve(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
  assert(manifest.name === 'agent-harness-codex' && manifest.version === '1.0.0' && manifest.skills === './skills/', 'RELEASE_CODEX_PLUGIN_INVALID', 'Packaged Codex plugin manifest is invalid.');
  const skillsRoot = resolve(pluginRoot, 'skills');
  const expected = ['agent-harness-command', 'agent-harness-extension-author', 'agent-harness-operator'];
  const actual = (await readdir(skillsRoot, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert(JSON.stringify(actual) === JSON.stringify(expected), 'RELEASE_SKILL_SET_INVALID', 'Packaged Codex plugin must contain only the generic command router and operator/extension Skills.', { expected, actual });
  for (const name of expected) {
    const skillFile = resolve(skillsRoot, name, 'SKILL.md');
    const text = await readFile(skillFile, 'utf8');
    assert(text.startsWith('---\n') && text.includes(`name: ${name}\n`), 'RELEASE_SKILL_ENTRYPOINT_INVALID', `Packaged Skill entrypoint is invalid: ${name}`);
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const reference = match[1];
      if (/^(?:https?:|#)/i.test(reference)) continue;
      const target = assertNoLinkPath(packageRoot, resolve(dirname(skillFile), reference), 'packaged Skill reference');
      assert(inside(packageRoot, target), 'RELEASE_SKILL_REFERENCE_OUTSIDE_PACKAGE', `Packaged Skill reference escapes the artifact: ${reference}`);
      await stat(target);
    }
  }
  const hooks = JSON.parse(await readFile(resolve(pluginRoot, 'hooks', 'hooks.json'), 'utf8'));
  assert(hooks.hooks?.UserPromptSubmit?.length === 1, 'RELEASE_CODEX_HOOK_INVALID', 'Packaged Codex plugin requires one UserPromptSubmit pseudo-command hook.');
  await stat(resolve(pluginRoot, 'hooks', 'pseudo-command-router.mjs'));
  await stat(resolve(pluginRoot, 'scripts', 'configure-bindings.mjs'));
  return true;
};

let scratch;
try {
  const [{ stdout: commitOutput }, { stdout: statusOutput }] = await Promise.all([
    run('git', ['rev-parse', 'HEAD']),
    run('git', ['status', '--porcelain=v1', '--untracked-files=all']),
  ]);
  const commit = commitOutput.trim().toLowerCase();
  assert(/^[a-f0-9]{40,64}$/.test(commit), 'RELEASE_SOURCE_COMMIT_INVALID', 'Release candidate requires a full Git commit identity.');
  assert(statusOutput.trim() === '', 'RELEASE_SOURCE_DIRTY', 'Release candidate refuses a dirty source tree. Commit the exact reviewed source first.');

  const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const manifestBytes = await readFile(resolve(root, 'release-manifest.json'));
  const sbomBytes = await readFile(resolve(root, 'sbom.spdx.json'));
  const identity = await verifyReleaseManifest({ root });
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const sbom = JSON.parse(sbomBytes.toString('utf8'));
  assert(sbom.spdxVersion === 'SPDX-2.3' && sbom.packages?.[0]?.versionInfo === packageJson.version && sbom.packages?.[0]?.checksums?.some(checksum => checksum.algorithm === 'SHA256' && checksum.checksumValue === identity.artifactDigest), 'RELEASE_SBOM_INVALID', 'SBOM does not bind the current release identity.');

  await mkdir(scratchRoot, { recursive: true });
  scratch = await mkdtemp(resolve(scratchRoot, 'run-'));
  await mkdir(npmCache, { recursive: true });
  const processTemporary = resolve(scratch, 'process-tmp');
  await mkdir(processTemporary, { recursive: true });
  const environment = {
    ...temporaryEnvironment(processTemporary, root),
    NPM_CONFIG_CACHE: npmCache,
    NPM_CONFIG_LOGS_DIR: resolve(scratch, 'npm-logs'),
    NPM_CONFIG_LOGS_MAX: '0',
    NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  };
  const packed = await run(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', scratch], { environment });
  const packResult = JSON.parse(packed.stdout)[0];
  assert(packResult?.filename && packResult.integrity && packResult.shasum && Array.isArray(packResult.files), 'RELEASE_NPM_PACK_RESULT_INVALID', 'npm pack did not return a complete package record.');
  const packedPaths = new Set(packResult.files.map(file => file.path));
  for (const file of manifest.files) assert(packedPaths.has(file.path), 'RELEASE_MANIFEST_FILE_NOT_PACKED', `Release manifest file is missing from the archive: ${file.path}`);
  for (const file of ['release-manifest.json', 'sbom.spdx.json', 'integrations/codex/agent-harness-codex/.codex-plugin/plugin.json']) assert(packedPaths.has(file), 'RELEASE_REQUIRED_FILE_NOT_PACKED', `Required release file is missing from the archive: ${file}`);

  const archiveSource = resolve(scratch, packResult.filename);
  const archiveBytes = await readFile(archiveSource);
  const archiveDigest = sha256(archiveBytes);
  const candidateDirectory = resolve(releaseRoot, packageJson.version, archiveDigest);
  await mkdir(candidateDirectory, { recursive: true });
  const archiveName = `agent-harness-${packageJson.version}-${archiveDigest.slice(0, 12)}.tgz`;
  const archiveTarget = resolve(candidateDirectory, archiveName);
  await cp(archiveSource, archiveTarget);

  const deployment = resolve(scratch, 'standalone-deployment');
  await mkdir(deployment, { recursive: true });
  await writeFile(resolve(deployment, 'package.json'), '{"name":"agent-harness-release-probe","private":true,"type":"module"}\n', 'utf8');
  await run(process.execPath, [npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--save=false', archiveTarget], { cwd: deployment, environment, inherit: true });
  const installedRoot = assertNoLinkPath(deployment, resolve(deployment, 'node_modules', 'agent-harness'), 'installed Agent Harness package');
  const installedIdentity = await verifyReleaseManifest({ root: installedRoot, artifactDigest: identity.artifactDigest });
  assert(installedIdentity.version === packageJson.version, 'RELEASE_INSTALLED_VERSION_MISMATCH', 'Installed release candidate version differs from package.json.');
  await validateSkills(installedRoot);

  const receipt = sealReleaseCandidateReceipt({
    protocolVersion: '1.0',
    kind: 'release-candidate-receipt',
    version: packageJson.version,
    source: { commit, clean: true },
    releaseManifest: { packageDigest: identity.artifactDigest, sha256: sha256(manifestBytes), fileCount: manifest.files.length },
    sbom: { sha256: sha256(sbomBytes), spdxVersion: sbom.spdxVersion },
    archive: { fileName: archiveName, sha256: archiveDigest, size: archiveBytes.length, npmIntegrity: packResult.integrity, npmShasum: packResult.shasum },
    probes: { manifestVerified: true, sbomVerified: true, packageInstalled: true, codexPluginVerified: true, skillEntrypointsVerified: true, relativeReferencesVerified: true, pathBoundaryVerified: true },
    createdAt: new Date().toISOString(),
  });
  await writeFile(resolve(candidateDirectory, 'release-candidate-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ ok: true, candidateDirectory, archive: archiveTarget, receipt: resolve(candidateDirectory, 'release-candidate-receipt.json'), archiveDigest, packageDigest: identity.artifactDigest }, null, 2));
} finally {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  await rm(npmCache, { recursive: true, force: true });
  for (const path of [scratchRoot, resolve(root, '.tmp'), resolve(root, '.agent-harness-cache')]) await rmdir(path).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
}
