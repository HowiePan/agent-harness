import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { harnessProjectRoot, harnessTemporaryRoot, verifyDevelopmentSourceManifest, writeDevelopmentSourceManifest } from '../src/index.mjs';
import { validateActiveReleaseBinding } from '../integrations/codex/agent-harness-codex/lib/active-release-binding.mjs';

test('development source manifest lets Codex bind exact source and rejects stale identities', async t => {
  const controlRoot = harnessProjectRoot();
  const parent = resolve(harnessTemporaryRoot(), 'development-binding-tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'case-'));
  const projectRoot = resolve(root, 'consumer');
  const dataRoot = resolve(root, 'data');
  await mkdir(projectRoot, { recursive: true });
  const configPath = resolve(projectRoot, 'harness.json');
  await writeFile(configPath, '{}\n');
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = await writeDevelopmentSourceManifest({ bindingId: 'consumer', sourceRoot: controlRoot, controlRoot, dataRoot, configPath, projectRoot });
  const verified = await verifyDevelopmentSourceManifest(output.file);
  assert.equal(verified.releaseIdentity.development, true);
  const active = await validateActiveReleaseBinding({ controlRoot, dataRoot, entrypoint: output.manifest.entrypoint, declaredRelease: { ...output.manifest.release, developmentManifest: output.file } });
  assert.equal(active.mode, 'source-link');
  assert.equal(active.artifactDigest, output.manifest.release.artifactDigest);
  await assert.rejects(() => validateActiveReleaseBinding({ controlRoot, dataRoot, entrypoint: output.manifest.entrypoint, declaredRelease: { ...output.manifest.release, artifactDigest: '0'.repeat(64), developmentManifest: output.file } }), /已过期/);
});
