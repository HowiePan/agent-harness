import { spawn } from 'node:child_process';
import { mkdir, readdir, rm, rmdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertHarnessWritePath, temporaryEnvironment } from '../src/write-boundary.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? 'all';
const selections = {
  all: (await readdir(resolve(root, 'test'))).filter(name => name.endsWith('.test.mjs')).sort().map(name => `test/${name}`),
  conformance: ['test/conformance.test.mjs'],
  canary: ['test/canary.test.mjs'],
};
const files = selections[mode];
if (!files) throw new Error(`Unknown test selection: ${mode}`);

const processRoot = assertHarnessWritePath(resolve(root, '.tmp', 'test-process'), 'test process temporary root');
const temporary = resolve(processRoot, `${process.pid}-${Date.now()}`);
await mkdir(temporary, { recursive: true });

const run = () => new Promise((resolveRun, reject) => {
  const child = spawn(process.execPath, ['--test', '--test-isolation=none', '--test-concurrency=1', ...files], { cwd: root, env: { ...process.env, ...temporaryEnvironment(temporary) }, windowsHide: true, stdio: 'inherit' });
  child.on('error', reject);
  child.on('close', (exitCode, signal) => resolveRun({ exitCode, signal }));
});

let outcome;
try {
  outcome = await run();
} finally {
  await rm(temporary, { recursive: true, force: true });
  for (const path of [processRoot, resolve(root, '.tmp', 'npm-logs'), resolve(root, '.tmp'), resolve(root, '.agent-harness-cache', 'npm'), resolve(root, '.agent-harness-cache')]) {
    await rmdir(path).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
  }
}

if (outcome.signal) {
  console.error(`Test process ended by signal ${outcome.signal}.`);
  process.exitCode = 1;
} else process.exitCode = outcome.exitCode ?? 1;
