import { copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestJson, sha256 } from '../src/common/canonical.mjs';
import { assert } from '../src/common/errors.mjs';
import { assertHarnessWritePath } from '../src/common/write-boundary.mjs';
import { verifyReleaseManifest } from '../src/application/release-identity.mjs';
import { packChannel } from './channel-pack-utils.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginPath = 'integrations/opencode';
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const pluginPkg = JSON.parse(await readFile(resolve(root, pluginPath, 'package.json'), 'utf8'));

assert(pluginPkg.name === 'agent-harness-opencode', 'OPENCODE_PACKAGE_NAME_INVALID', 'OpenCode package name is invalid.');
assert(pluginPkg.version === packageJson.version, 'OPENCODE_PACKAGE_VERSION_MISMATCH', 'OpenCode package version must match Core version.');

const core = await verifyReleaseManifest({ root });

const files = [];
const visit = async file => {
  const info = await lstat(file);
  assert(!info.isSymbolicLink(), 'OPENCODE_PACKAGE_LINK_FORBIDDEN', `OpenCode package cannot contain a link: ${file}`);
  if (info.isDirectory()) {
    for (const entry of await readdir(file)) {
      if (entry === '.plugin-data' || entry === 'tests') continue;
      await visit(resolve(file, entry));
    }
  } else {
    assert(info.isFile(), 'OPENCODE_PACKAGE_NODE_INVALID', `OpenCode package requires regular files: ${file}`);
    const path = relative(root, file).replaceAll('\\', '/');
    const bytes = await readFile(file);
    files.push({ path, sha256: sha256(bytes), size: bytes.length });
  }
};

await visit(resolve(root, pluginPath, 'src'));
await visit(resolve(root, pluginPath, 'commands'));
await visit(resolve(root, pluginPath, 'skills'));
const topFiles = ['package.json', 'README.md'];
for (const f of topFiles) {
  const full = resolve(root, pluginPath, f);
  const bytes = await readFile(full);
  files.push({ path: `${pluginPath}/${f}`, sha256: sha256(bytes), size: bytes.length });
}

files.sort((a, b) => a.path.localeCompare(b.path));
const channelManifest = {
  protocolVersion: '1.0',
  channel: 'opencode',
  plugin: { name: pluginPkg.name, version: pluginPkg.version },
  requiresCore: { name: packageJson.name, version: core.version, packageDigest: core.artifactDigest },
  layout: { pluginPath },
  files,
  contentDigest: digestJson(files),
};
channelManifest.artifactDigest = digestJson(channelManifest);

const stage = assertHarnessWritePath(resolve(root, '.tmp', `opencode-stage-${process.pid}-${Date.now()}`), 'OpenCode package stage', root);
try {
  for (const file of files) {
    const destination = resolve(stage, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(resolve(root, file.path), destination);
  }
  await writeFile(resolve(stage, 'opencode-channel-manifest.json'), `${JSON.stringify(channelManifest, null, 2)}\n`, 'utf8');
  await writeFile(resolve(stage, 'package.json'), `${JSON.stringify({ name: 'agent-harness-opencode-channel', version: pluginPkg.version, description: 'OpenCode host plugin overlay for an exact Agent Harness core artifact', license: packageJson.license, type: 'module', files: [pluginPath, 'opencode-channel-manifest.json'] }, null, 2)}\n`, 'utf8');

  const result = await packChannel({
    root,
    channel: 'opencode',
    source: stage,
    npmCli: process.env.npm_execpath,
    expectedFiles: [...files.map(f => f.path), 'opencode-channel-manifest.json', 'package.json'],
    forbiddenPrefixes: ['src/', 'schemas/', 'integrations/codex/', 'integrations/vscode/'],
    identity: channelManifest.artifactDigest,
  });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result, plugin: channelManifest.plugin, requiredCorePackageDigest: core.artifactDigest, contentDigest: channelManifest.contentDigest, artifactDigest: channelManifest.artifactDigest }, null, 2)}\n`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
