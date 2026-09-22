import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertChannelContents } from '../scripts/channel-pack-utils.mjs';

const root = resolve('.');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(resolve(root, 'release-manifest.json'), 'utf8'));

test('Core package excludes the Codex host plugin and marketplace while retaining the runtime adapter', () => {
  assert.equal(packageJson.scripts['pack:core'], 'node scripts/pack-core.mjs');
  assert.equal(packageJson.scripts['pack:codex'], 'node scripts/pack-codex.mjs');
  assert.equal(packageJson.scripts['pack:opencode'], 'node scripts/pack-opencode.mjs');
  assert.equal(packageJson.scripts['pack:vscode'], 'node scripts/pack-vscode.mjs');
  assert.equal(packageJson.scripts['deploy:codex'], 'node scripts/deploy-codex-overlay.mjs');
  assert.equal(packageJson.scripts['check:codex-host-fast'].includes('post-tool-host-bootstrap.test.mjs'), true);
  assert.equal(packageJson.scripts['release:codex:prepare'].includes('--prepare'), true);
  assert.equal(packageJson.scripts['release:codex:local'].includes('release-codex.mjs'), true);
  assert.equal(Object.hasOwn(packageJson.scripts, 'release:plugin'), false);
  assert.equal(Object.hasOwn(packageJson.scripts, 'release:plugin:check'), false);
  assert.equal(packageJson.files.some(path => path.startsWith('integrations/codex/agent-harness-codex/') || path === '.agents/' || path.startsWith('integrations/opencode/') || path.startsWith('integrations/vscode/')), false);
  assert.equal(manifest.files.some(file => file.path.startsWith('integrations/codex/agent-harness-codex/') || file.path.startsWith('.agents/') || file.path.startsWith('integrations/opencode/') || file.path.startsWith('integrations/vscode/')), false);
  assert.equal(manifest.files.some(file => file.path === 'integrations/codex/runtime/codex-runtime.mjs'), true);
});

test('channel archives require their own files and reject cross-channel content', () => {
  assertChannelContents({ channel: 'codex', packedFiles: ['integrations/codex/agent-harness-codex/.codex-plugin/plugin.json', 'codex-channel-manifest.json'], expectedFiles: ['integrations/codex/agent-harness-codex/.codex-plugin/plugin.json', 'codex-channel-manifest.json'], forbiddenPrefixes: ['src/'] });
  assert.throws(() => assertChannelContents({ channel: 'codex', packedFiles: ['package.json'], expectedFiles: ['codex-channel-manifest.json'] }), error => error.code === 'CHANNEL_PACK_FILE_MISSING');
  assert.throws(() => assertChannelContents({ channel: 'core', packedFiles: ['integrations/codex/agent-harness-codex/hooks/hooks.json'], expectedFiles: [], forbiddenPrefixes: ['integrations/codex/agent-harness-codex/'] }), error => error.code === 'CHANNEL_PACK_CROSS_CHANNEL_FILE');
  assert.throws(() => assertChannelContents({ channel: 'codex', packedFiles: ['codex-channel-manifest.json', 'secret.txt'], expectedFiles: ['codex-channel-manifest.json'] }), error => error.code === 'CHANNEL_PACK_UNEXPECTED_FILE');
});
