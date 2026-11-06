// Deterministic native Gate regression host. Its children create their own
// production Gate slots; the host has a separate exclusive test slot and one
// encompassing Job, so fixtures cannot deadlock on their parent's Gate slot.
import { resolve } from 'node:path';
import { lstat, mkdir } from 'node:fs/promises';
import { assert } from '../src/common/errors.mjs';
import { assertNoLinkPath } from '../src/common/paths.mjs';
import { harnessProjectRoot } from '../src/common/write-boundary.mjs';
import { runResourceBounded, SCRIPT_RESOURCE_LIMITS } from '../src/platform/plugins/execution/resource-guard.mjs';

try {
  const root = harnessProjectRoot();
  const tests = process.argv.slice(2);
  assert(tests.length > 0 && tests.length <= 16 && tests.every(path => /^test\/[a-z0-9.-]+\.test\.mjs$/.test(path)),
    'TEST_HOST_INPUT_INVALID', 'Supply 1-16 exact repository test files; no programs, commands or provider runtimes.');
  let bytes = 0;
  for (const path of tests) { const info = await lstat(assertNoLinkPath(root, resolve(root, path)));
    assert(info.isFile(), 'TEST_HOST_INPUT_INVALID', 'Tests must be regular files.'); bytes += info.size; }
  assert(bytes <= SCRIPT_RESOURCE_LIMITS.maxInputBytes, 'SCRIPT_SPLIT_REQUIRED', 'Split the test suite.');
  const temporary = resolve(root, '.tmp', 'test-host-temp'); await mkdir(temporary, { recursive: true });
  const result = await runResourceBounded({ launch: { executable: process.execPath,
    args: ['--max-old-space-size=256', '--test', '--test-isolation=none', ...tests], cwd: root,
    environment: { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary } },
    limits: SCRIPT_RESOURCE_LIMITS, resourceRoot: resolve(root, '.tmp', 'test-host-supervision'),
    onProgress: event => { if (event.phase === 'process-started' || event.phase === 'process-observation') process.stderr.write(`${JSON.stringify(event)}\n`); } });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.exitCode === 0 && !result.environmentError ? 0 : 1;
} catch (error) { process.stderr.write(`${JSON.stringify({ code: error.code ?? 'TEST_HOST_FAILED', message: error.message })}\n`); process.exitCode = 1; }
