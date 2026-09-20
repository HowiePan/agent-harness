import { copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestJson, sha256 } from '../src/common/canonical.mjs';
import { assert } from '../src/common/errors.mjs';
import { assertHarnessWritePath } from '../src/common/write-boundary.mjs';
import { verifyReleaseManifest } from '../src/application/release-identity.mjs';
import { validateReleaseVersionContract } from './release-version-contract.mjs';
import { packChannel } from './channel-pack-utils.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginPath = 'integrations/codex/agent-harness-codex';
const marketplacePath = '.agents/plugins/marketplace.json';
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const plugin = JSON.parse(await readFile(resolve(root, pluginPath, '.codex-plugin/plugin.json'), 'utf8'));
const marketplace = JSON.parse(await readFile(resolve(root, marketplacePath), 'utf8'));
const errors = validateReleaseVersionContract({ packageJson, codexPlugin: plugin });
assert(errors.length === 0, 'CODEX_PACKAGE_VERSION_INVALID', errors.join('; '));
assert(plugin.name === 'agent-harness-codex' && marketplace.plugins?.length === 1 && marketplace.plugins[0]?.source?.path === `./${pluginPath}`, 'CODEX_PACKAGE_SOURCE_INVALID', 'Codex package must bind the in-repository plugin and marketplace.');
const core = await verifyReleaseManifest({ root });

const files = [];
const visit = async file => {
  const info = await lstat(file);
  assert(!info.isSymbolicLink(), 'CODEX_PACKAGE_LINK_FORBIDDEN', `Codex package cannot contain a link: ${file}`);
  if (info.isDirectory()) {
    for (const entry of await readdir(file)) {
      if (entry === '.plugin-data') continue;
      await visit(resolve(file, entry));
    }
  } else {
    assert(info.isFile(), 'CODEX_PACKAGE_NODE_INVALID', `Codex package requires regular files: ${file}`);
    const path = relative(root, file).replaceAll('\\', '/');
    const bytes = await readFile(file);
    files.push({ path, sha256: sha256(bytes), size: bytes.length });
  }
};
await visit(resolve(root, pluginPath));
await visit(resolve(root, marketplacePath));
files.sort((a, b) => a.path.localeCompare(b.path));
const channelManifest = {
  protocolVersion: '1.0', channel: 'codex',
  plugin: { name: plugin.name, version: plugin.version },
  requiresCore: { name: packageJson.name, version: core.version, packageDigest: core.artifactDigest },
  layout: { pluginPath, marketplacePath }, files, contentDigest: digestJson(files),
};
channelManifest.artifactDigest = digestJson(channelManifest);
const stage = assertHarnessWritePath(resolve(root, '.tmp', `codex-stage-${process.pid}-${Date.now()}`), 'Codex package stage', root);
try {
  for (const file of files) {
    const destination = resolve(stage, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(resolve(root, file.path), destination);
    const stagedBytes = await readFile(destination);
    assert(stagedBytes.length === file.size && sha256(stagedBytes) === file.sha256, 'CODEX_PACKAGE_SOURCE_DRIFT', `Codex source changed during staging: ${file.path}`);
  }
  await writeFile(resolve(stage, 'codex-channel-manifest.json'), `${JSON.stringify(channelManifest, null, 2)}\n`, 'utf8');
  await writeFile(resolve(stage, 'package.json'), `${JSON.stringify({ name: 'agent-harness-codex-channel', version: plugin.version, description: 'Codex host plugin overlay for an exact Agent Harness core artifact', license: packageJson.license, type: 'module', files: [pluginPath, marketplacePath, 'codex-channel-manifest.json'] }, null, 2)}\n`, 'utf8');
  const result = await packChannel({
    root, channel: 'codex', source: stage, npmCli: process.env.npm_execpath,
    identity: channelManifest.artifactDigest,
    expectedFiles: [...files.map(file => file.path), 'codex-channel-manifest.json', 'package.json'],
    forbiddenPrefixes: ['src/', 'schemas/', 'integrations/codex/runtime/'],
  });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result, plugin: channelManifest.plugin, requiredCorePackageDigest: core.artifactDigest, contentDigest: channelManifest.contentDigest, artifactDigest: channelManifest.artifactDigest }, null, 2)}\n`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
