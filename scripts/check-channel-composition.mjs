import { spawn } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { digestJson, sha256 } from '../src/common/canonical.mjs';
import { assert } from '../src/common/errors.mjs';
import { verifyReleaseManifest } from '../src/application/release-identity.mjs';
import { assertHarnessWritePath, temporaryEnvironment } from '../src/common/write-boundary.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
assert(args.length === 4 && args[0] === '--core' && args[2] === '--codex', 'CHANNEL_PROBE_ARGUMENTS_INVALID', 'Usage: node scripts/check-channel-composition.mjs --core <archive> --codex <archive>.');
const coreArchive = resolve(args[1]);
const codexArchive = resolve(args[3]);
for (const archive of [coreArchive, codexArchive]) {
  const rel = relative(assertHarnessWritePath(resolve(root, '.agent-harness-data', 'channel-packages'), 'channel package root', root), archive);
  assert(rel && !rel.startsWith('..') && !isAbsolute(rel), 'CHANNEL_PROBE_ARCHIVE_OUTSIDE_ROOT', 'Channel archive must be inside the managed package directory.');
}
const scratchRoot = assertHarnessWritePath(resolve(root, '.tmp', 'channel-composition'), 'channel composition scratch', root);
const cache = assertHarnessWritePath(resolve(root, '.agent-harness-cache', 'npm'), 'channel composition npm cache', root);
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(resolve(scratchRoot, 'run-'));
try {
  await mkdir(cache, { recursive: true });
  const temporary = resolve(scratch, 'process-tmp');
  await mkdir(temporary, { recursive: true });
  await writeFile(resolve(scratch, 'package.json'), '{"name":"agent-harness-channel-probe","private":true,"type":"module"}\n', 'utf8');
  const npmCli = process.env.npm_execpath;
  assert(npmCli, 'NPM_EXECUTABLE_REQUIRED', 'Channel composition probe must be started through npm.');
  await new Promise((resolveRun, reject) => {
    process.stderr.write('[process:start] npm install (channel composition)\n');
    const child = spawn(process.execPath, [npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--save=false', coreArchive, codexArchive], {
      cwd: scratch, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...temporaryEnvironment(temporary, root), NPM_CONFIG_CACHE: cache, NPM_CONFIG_LOGS_DIR: resolve(scratch, 'npm-logs'), NPM_CONFIG_LOGS_MAX: '0', NPM_CONFIG_UPDATE_NOTIFIER: 'false' },
    });
    let stderr = '';
    child.stdout.on('data', chunk => { process.stderr.write(chunk); });
    child.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(chunk); });
    child.on('error', error => { process.stderr.write(`[process:error] npm install (channel composition): ${error.message}\n`); reject(error); });
    child.on('close', (code, signal) => {
      process.stderr.write(`[process:finish] npm install (channel composition) exit=${code ?? 'null'} signal=${signal ?? 'none'}\n`);
      code === 0 && !signal ? resolveRun() : reject(new Error(`Channel install probe failed: ${stderr.trim() || signal || code}`));
    });
  });
  const coreRoot = resolve(scratch, 'node_modules', 'agent-harness');
  const codexRoot = resolve(scratch, 'node_modules', 'agent-harness-codex-channel');
  const coreIdentity = await verifyReleaseManifest({ root: coreRoot });
  const channelManifest = JSON.parse(await readFile(resolve(codexRoot, 'codex-channel-manifest.json'), 'utf8'));
  const { artifactDigest, ...body } = channelManifest;
  assert(channelManifest.channel === 'codex' && artifactDigest === digestJson(body), 'CHANNEL_PROBE_MANIFEST_INVALID', 'Codex channel manifest digest is invalid.');
  assert(channelManifest.requiresCore?.packageDigest === coreIdentity.artifactDigest && channelManifest.requiresCore?.version === coreIdentity.version, 'CHANNEL_PROBE_CORE_MISMATCH', 'Codex package requires a different Core artifact.');
  assert(channelManifest.contentDigest === digestJson(channelManifest.files), 'CHANNEL_PROBE_FILE_LIST_INVALID', 'Codex channel file list digest is invalid.');
  for (const file of channelManifest.files) {
    assert(file.path.startsWith('integrations/codex/agent-harness-codex/') || file.path === '.agents/plugins/marketplace.json', 'CHANNEL_PROBE_PATH_INVALID', `Unexpected Codex package path: ${file.path}`);
    const source = resolve(codexRoot, file.path);
    const target = resolve(coreRoot, file.path);
    for (const [base, candidate] of [[codexRoot, source], [coreRoot, target]]) {
      const pathWithin = relative(base, candidate);
      assert(pathWithin && !pathWithin.startsWith('..') && !isAbsolute(pathWithin), 'CHANNEL_PROBE_PATH_INVALID', `Codex package path escapes its root: ${file.path}`);
    }
    assert((await lstat(source)).isFile(), 'CHANNEL_PROBE_FILE_INVALID', `Codex package contains a non-file: ${file.path}`);
    const bytes = await readFile(source);
    assert(bytes.length === file.size && sha256(bytes) === file.sha256, 'CHANNEL_PROBE_FILE_MISMATCH', `Codex package file changed: ${file.path}`);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  const hook = await import(pathToFileURL(resolve(coreRoot, 'integrations/codex/agent-harness-codex/hooks/pseudo-command-router.mjs')).href);
  assert(typeof hook.parsePseudoCommand === 'function', 'CHANNEL_PROBE_HOOK_INVALID', 'Composed Codex Hook did not load against the packaged Core.');
  const parsed = hook.parsePseudoCommand('h:engine quality V3.8.4 review-only');
  assert(parsed.kind === 'command' && parsed.action === 'quality', 'CHANNEL_PROBE_COMMAND_INVALID', 'Composed Codex Hook did not parse a known command.');
  process.stdout.write(`${JSON.stringify({ ok: true, corePackageDigest: coreIdentity.artifactDigest, codexArtifactDigest: artifactDigest, pluginFiles: channelManifest.files.length, hookLoaded: true }, null, 2)}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
  await rmdir(scratchRoot).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
  await rmdir(resolve(root, '.tmp')).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
  await rm(cache, { recursive: true, force: true });
  await rmdir(resolve(root, '.agent-harness-cache')).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
}
