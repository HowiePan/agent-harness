import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestJson, sha256 } from '../src/common/canonical.mjs';
import { assert } from '../src/common/errors.mjs';
import { assertNoLinkPath } from '../src/common/paths.mjs';
import { assertHarnessWritePath, temporaryEnvironment } from '../src/common/write-boundary.mjs';
import { verifyReleaseManifest } from '../src/application/release-identity.mjs';
import { readActiveRelease, resolveActiveRuntimeRoot } from '../src/platform/registry/active-generation.mjs';
import { createRuntimeCompositionManifest, verifyRuntimeComposition } from '../src/platform/maintenance/runtime-composition.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = assertHarnessWritePath(resolve(root, '.agent-harness-data'), 'Harness data root', root);
const args = process.argv.slice(2);
assert(args.length === 2 && args[0] === '--archive', 'CODEX_OVERLAY_ARGUMENTS_INVALID', 'Usage: npm run deploy:codex -- --archive <codex.tgz>');
const archive = assertNoLinkPath(resolve(dataRoot, 'channel-packages', 'codex'), resolve(args[1]), 'Codex channel archive');
const archiveBytes = await readFile(archive);
const packageReceipt = JSON.parse(await readFile(resolve(dirname(archive), 'codex-package-receipt.json'), 'utf8'));
assert(packageReceipt.channel === 'codex' && resolve(packageReceipt.archive) === archive && packageReceipt.archiveDigest === sha256(archiveBytes), 'CODEX_OVERLAY_ARCHIVE_INVALID', 'Codex channel archive does not match its package receipt.');
const npmCli = process.env.npm_execpath;
assert(npmCli, 'NPM_EXECUTABLE_REQUIRED', 'deploy:codex must be started through npm.');
const pointer = await readActiveRelease(dataRoot, root);
assert(pointer, 'CODEX_OVERLAY_ACTIVE_RELEASE_REQUIRED', 'An exact Core runtime must be active before deploying Codex.');
const sourceRuntimeRoot = await resolveActiveRuntimeRoot(dataRoot, root);
const core = await verifyReleaseManifest({ root: sourceRuntimeRoot, artifactDigest: pointer.release?.artifactDigest });
const scratchRoot = assertHarnessWritePath(resolve(root, '.tmp', 'codex-overlay'), 'Codex overlay scratch', root);
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(resolve(scratchRoot, 'run-'));
try {
  await writeFile(resolve(scratch, 'package.json'), '{"name":"codex-overlay-probe","private":true,"type":"module"}\n');
  const cache = assertHarnessWritePath(resolve(scratch, 'npm-cache'), 'Codex overlay npm cache', root);
  await mkdir(cache, { recursive: true });
  const processTmp = resolve(scratch, 'process-tmp');
  await mkdir(processTmp, { recursive: true });
  await new Promise((resolveRun, reject) => {
    process.stderr.write('[process:start] npm install (Codex overlay)\n');
    const child = spawn(process.execPath, [npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--save=false', archive], {
      cwd: scratch, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...temporaryEnvironment(processTmp, root), NPM_CONFIG_CACHE: cache, NPM_CONFIG_LOGS_DIR: resolve(scratch, 'npm-logs'), NPM_CONFIG_LOGS_MAX: '0', NPM_CONFIG_UPDATE_NOTIFIER: 'false' },
    });
    child.stdout.on('data', chunk => process.stderr.write(chunk));
    child.stderr.on('data', chunk => process.stderr.write(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      process.stderr.write(`[process:finish] npm install (Codex overlay) exit=${code ?? 'null'} signal=${signal ?? 'none'}\n`);
      code === 0 && !signal ? resolveRun() : reject(new Error(`Codex overlay npm install failed: ${signal ?? code}`));
    });
  });
  const packageRoot = resolve(scratch, 'node_modules', 'agent-harness-codex-channel');
  const manifest = JSON.parse(await readFile(resolve(packageRoot, 'codex-channel-manifest.json'), 'utf8'));
  const { artifactDigest, ...body } = manifest;
  assert(manifest.protocolVersion === '1.0' && manifest.channel === 'codex' && Array.isArray(manifest.files) && artifactDigest === digestJson(body) && manifest.contentDigest === digestJson(manifest.files), 'CODEX_OVERLAY_MANIFEST_INVALID', 'Codex channel manifest is invalid.');
  assert(packageReceipt.identity === artifactDigest, 'CODEX_OVERLAY_IDENTITY_MISMATCH', 'Codex channel package identity does not match its archive receipt.');
  assert(manifest.requiresCore?.packageDigest === core.artifactDigest && manifest.requiresCore?.version === core.version, 'CODEX_OVERLAY_CORE_MISMATCH', 'Codex channel package does not bind the active Core.');
  assert(manifest.layout?.pluginPath === 'integrations/codex/agent-harness-codex' && manifest.layout?.marketplacePath === '.agents/plugins/marketplace.json', 'CODEX_OVERLAY_LAYOUT_INVALID', 'Codex channel layout is invalid.');
  const files = new Set();
  for (const item of manifest.files) {
    assert(typeof item.path === 'string' && (item.path.startsWith(`${manifest.layout.pluginPath}/`) || item.path === manifest.layout.marketplacePath) && !isAbsolute(item.path) && !item.path.split('/').includes('..') && !files.has(item.path), 'CODEX_OVERLAY_FILE_INVALID', 'Codex channel contains an invalid or duplicate path.');
    files.add(item.path);
    const source = assertNoLinkPath(packageRoot, resolve(packageRoot, item.path), 'Codex overlay source');
    const bytes = await readFile(source);
    assert(bytes.length === item.size && sha256(bytes) === item.sha256, 'CODEX_OVERLAY_FILE_MISMATCH', `Codex channel file changed: ${item.path}`);
  }
  assert(files.has(`${manifest.layout.pluginPath}/scripts/visible-lifecycle-coordinator.mjs`), 'CODEX_OVERLAY_COORDINATOR_MISSING', 'Codex channel is missing the visible lifecycle Coordinator.');
  const composition = createRuntimeCompositionManifest({
    core: { version: core.version, artifactDigest: core.artifactDigest, verified: true },
    channels: [{ id: 'codex', version: manifest.plugin.version, artifactDigest, manifest: 'codex-channel-manifest.json' }],
  });
  const runtimeRoot = assertHarnessWritePath(resolve(dataRoot, 'compositions', core.version, composition.compositionDigest), 'Immutable runtime composition', root);
  let existingComposition = false;
  try {
    await verifyRuntimeComposition({ controlRoot: root, runtimeRoot, expectedDigest: composition.compositionDigest, expectedCore: composition.core, expectedChannels: composition.channels });
    existingComposition = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!existingComposition) {
    const stagingRoot = assertHarnessWritePath(`${runtimeRoot}.staging-${process.pid}`, 'Runtime composition staging root', root);
    await rm(stagingRoot, { recursive: true, force: true });
    await mkdir(stagingRoot, { recursive: true });
    try {
      const coreManifest = JSON.parse(await readFile(resolve(sourceRuntimeRoot, 'release-manifest.json'), 'utf8'));
      for (const item of coreManifest.files) {
        const target = resolve(stagingRoot, item.path);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(assertNoLinkPath(sourceRuntimeRoot, resolve(sourceRuntimeRoot, item.path), 'Core composition source'), target);
      }
      for (const metadataFile of coreManifest.metadataFiles ?? ['release-manifest.json', 'sbom.spdx.json']) {
        const target = resolve(stagingRoot, metadataFile);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(assertNoLinkPath(sourceRuntimeRoot, resolve(sourceRuntimeRoot, metadataFile), 'Core composition metadata'), target);
      }
      for (const item of manifest.files) {
        const target = assertNoLinkPath(stagingRoot, resolve(stagingRoot, item.path), 'Codex composition target');
        await mkdir(dirname(target), { recursive: true });
        await copyFile(resolve(packageRoot, item.path), target);
      }
      await writeFile(resolve(stagingRoot, 'codex-channel-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      await writeFile(resolve(stagingRoot, 'runtime-composition.json'), `${JSON.stringify(composition, null, 2)}\n`);
      await verifyRuntimeComposition({ controlRoot: root, runtimeRoot: stagingRoot, expectedDigest: composition.compositionDigest, expectedCore: composition.core, expectedChannels: composition.channels });
      await mkdir(dirname(runtimeRoot), { recursive: true });
      await rename(stagingRoot, runtimeRoot);
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true });
      throw error;
    }
  }
  await verifyRuntimeComposition({ controlRoot: root, runtimeRoot, expectedDigest: composition.compositionDigest, expectedCore: composition.core, expectedChannels: composition.channels });
  const receiptRoot = assertHarnessWritePath(resolve(dataRoot, 'channel-deployments', 'codex', composition.compositionDigest), 'Codex overlay receipt root', root);
  await mkdir(receiptRoot, { recursive: true });
  const receipt = { protocolVersion: '1.0', kind: 'runtime-composition-deployment-receipt', core: composition.core, channels: composition.channels, compositionDigest: composition.compositionDigest, sourceRuntimeRoot, runtimeRoot, fileCount: manifest.files.length, archive, deployedAt: new Date().toISOString() };
  const receiptFile = resolve(receiptRoot, 'receipt.json');
  await writeFile(receiptFile, `${JSON.stringify({ ...receipt, receiptDigest: digestJson(receipt) }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: true, ...receipt, receipt: receiptFile }, null, 2)}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
  for (const path of [scratchRoot, resolve(root, '.tmp')]) await rmdir(path).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
}
