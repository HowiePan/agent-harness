import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyReleaseManifest } from '../src/application/release-identity.mjs';
import { packChannel } from './channel-pack-utils.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const identity = await verifyReleaseManifest({ root });
const manifest = JSON.parse(await readFile(resolve(root, 'release-manifest.json'), 'utf8'));
const result = await packChannel({
  root, channel: 'core', source: root, npmCli: process.env.npm_execpath,
  identity: identity.artifactDigest,
  expectedFiles: [...manifest.files.map(file => file.path), 'release-manifest.json', 'sbom.spdx.json'],
  forbiddenPrefixes: ['integrations/codex/agent-harness-codex/', '.agents/'],
});
process.stdout.write(`${JSON.stringify({ ok: true, ...result, packageDigest: identity.artifactDigest }, null, 2)}\n`);
