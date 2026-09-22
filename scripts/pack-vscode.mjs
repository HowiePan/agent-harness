import { copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestJson, sha256 } from '../src/common/canonical.mjs';
import { assert } from '../src/common/errors.mjs';
import { assertHarnessWritePath } from '../src/common/write-boundary.mjs';
import { verifyReleaseManifest } from '../src/application/release-identity.mjs';
import { packChannel } from './channel-pack-utils.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginPath = 'integrations/vscode';
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const extensionPkg = JSON.parse(await readFile(resolve(root, pluginPath, 'package.json'), 'utf8'));

assert(extensionPkg.name === 'agent-harness-vscode', 'VSCODE_PACKAGE_NAME_INVALID', 'VS Code package name is invalid.');
assert(extensionPkg.version === packageJson.version, 'VSCODE_PACKAGE_VERSION_MISMATCH', 'VS Code package version must match Core version.');

const core = await verifyReleaseManifest({ root });

const files = [];
const visit = async file => {
  const info = await lstat(file);
  assert(!info.isSymbolicLink(), 'VSCODE_PACKAGE_LINK_FORBIDDEN', `VS Code package cannot contain a link: ${file}`);
  if (info.isDirectory()) {
    for (const entry of await readdir(file)) {
      if (entry === '.plugin-data' || entry === 'tests') continue;
      await visit(resolve(file, entry));
    }
  } else {
    assert(info.isFile(), 'VSCODE_PACKAGE_NODE_INVALID', `VS Code package requires regular files: ${file}`);
    const path = relative(root, file).replaceAll('\\', '/');
    const bytes = await readFile(file);
    files.push({ path, sha256: sha256(bytes), size: bytes.length });
  }
};

await visit(resolve(root, pluginPath, 'src'));
const topFiles = ['package.json', 'README.md'];
for (const f of topFiles) {
  const full = resolve(root, pluginPath, f);
  const bytes = await readFile(full);
  files.push({ path: `${pluginPath}/${f}`, sha256: sha256(bytes), size: bytes.length });
}

files.sort((a, b) => a.path.localeCompare(b.path));
const channelManifest = {
  protocolVersion: '1.0',
  channel: 'vscode',
  plugin: { name: extensionPkg.name, version: extensionPkg.version },
  requiresCore: { name: packageJson.name, version: core.version, packageDigest: core.artifactDigest },
  layout: { pluginPath },
  files,
  contentDigest: digestJson(files),
};
channelManifest.artifactDigest = digestJson(channelManifest);

const stage = assertHarnessWritePath(resolve(root, '.tmp', `vscode-stage-${process.pid}-${Date.now()}`), 'VS Code package stage', root);
try {
  for (const file of files) {
    const destination = resolve(stage, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(resolve(root, file.path), destination);
  }
  await writeFile(resolve(stage, 'vscode-channel-manifest.json'), `${JSON.stringify(channelManifest, null, 2)}\n`, 'utf8');
  await writeFile(resolve(stage, 'package.json'), `${JSON.stringify({ name: 'agent-harness-vscode-channel', version: extensionPkg.version, description: 'VS Code host extension overlay for an exact Agent Harness core artifact', license: packageJson.license, type: 'module', files: [pluginPath, 'vscode-channel-manifest.json'] }, null, 2)}\n`, 'utf8');

  const result = await packChannel({
    root,
    channel: 'vscode',
    source: stage,
    npmCli: process.env.npm_execpath,
    expectedFiles: [...files.map(f => f.path), 'vscode-channel-manifest.json', 'package.json'],
    forbiddenPrefixes: ['src/', 'integrations/codex/', 'integrations/opencode/'],
    identity: core.artifactDigest,
  });
  console.log(JSON.stringify({ ok: true, channel: 'vscode', ...result }, null, 2));
} finally {
  await rm(stage, { recursive: true, force: true });
}
