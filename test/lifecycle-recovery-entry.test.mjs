import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

test('independent recovery CLI rejects before manifest IO or Host creation, even with old-looking identity flags', async () => {
  const script = resolve('integrations/codex/agent-harness-codex/scripts/visible-development-recovery.mjs');
  try {
    await promisify(execFile)(process.execPath, [script, '--manifest', resolve('.tmp', 'missing-native-start-manifest.json'), '--run', 'old-sealed-run'],
      { cwd: process.cwd(), windowsHide: true, env: { ...process.env, CODEX_SESSION_ID: 'historical-session' }, maxBuffer: 65536 });
    assert.fail('Independent recovery must refuse execution');
  } catch (error) {
    assert.equal(error.code, 1);
    const output = JSON.parse(error.stdout.trim()); assert.equal(output.code, 'CURRENT_USER_COMMAND_REQUIRED');
    assert.equal(output.phase, 'error');
  }
  const source = await readFile(script, 'utf8');
  assert.doesNotMatch(source, /harness\.(?:executeVisibleLifecyclePlan|continueVisibleLifecyclePlan|createExecutionReadinessReport)\(/,
    'Preparation has no business start or Gate/preflight fallback');
});
