import { spawn } from 'node:child_process';
import { mkdir, rm, rmdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertHarnessWritePath, temporaryEnvironment } from '../src/write-boundary.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = assertHarnessWritePath(resolve(root, '.tmp', `pack-${process.pid}-${Date.now()}`), 'pack temporary directory');
const cache = assertHarnessWritePath(resolve(root, '.agent-harness-cache', 'npm'), 'npm cache directory');
await mkdir(temporary, { recursive: true });
await mkdir(cache, { recursive: true });

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('pack:dry-run must be started through npm so npm_execpath is available.');
const outcome = await new Promise((resolveRun, reject) => {
  process.stderr.write('[process:start] npm pack --dry-run\n');
  const child = spawn(process.execPath, [npmCli, 'pack', '--dry-run'], { cwd: root, env: { ...process.env, NPM_CONFIG_CACHE: cache, NPM_CONFIG_UPDATE_NOTIFIER: 'false', ...temporaryEnvironment(temporary) }, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { process.stderr.write(`[process:error] ${error.message}\n`); reject(error); });
  child.on('close', (exitCode, signal) => { process.stderr.write(`[process:finish] exit=${exitCode ?? 'null'} signal=${signal ?? 'none'}\n`); resolveRun({ exitCode, signal }); });
}).finally(async () => {
  await rm(temporary, { recursive: true, force: true });
  await rm(cache, { recursive: true, force: true });
  for (const path of [resolve(root, '.tmp', 'npm-logs'), resolve(root, '.tmp'), resolve(root, '.agent-harness-cache')]) {
    await rmdir(path).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
  }
});

process.exitCode = outcome.signal ? 1 : outcome.exitCode ?? 1;
