import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateReleaseVersionContract } from '../scripts/release-version-contract.mjs';

test('Codex plugin version exactly matches the strict Harness release version', async () => {
  const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  const codexPlugin = JSON.parse(await readFile(resolve('integrations', 'codex', 'agent-harness-codex', '.codex-plugin', 'plugin.json'), 'utf8'));

  assert.deepEqual(validateReleaseVersionContract({ packageJson, codexPlugin }), []);
  assert.equal(codexPlugin.version, '1.0.0');
});

test('Codex cachebuster and other version suffixes are rejected before packaging', () => {
  const packageJson = { version: '1.0.0' };

  for (const version of ['1.0.0+codex.20260914151025', '1.0.0+local', '1.0.0-rc.1']) {
    const errors = validateReleaseVersionContract({ packageJson, codexPlugin: { version } });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /must exactly equal package version 1\.0\.0/);
  }
});
