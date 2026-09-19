import { cp, mkdir, mkdtemp, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { temporaryEnvironment } from '../src/common/write-boundary.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = resolve(source, '.tmp', 'clean-room');
await mkdir(scratch, { recursive: true });
const temporary = await mkdtemp(resolve(scratch, 'run-'));
const project = resolve(temporary, 'agent-harness');
const processTemporary = resolve(project, '.tmp', 'parent-process');
const run = (args, { cwd = project, environment = {} } = {}) => new Promise((resolveRun, reject) => {
  process.stderr.write(`[process:start] node ${args.join(' ')}\n`);
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...temporaryEnvironment(processTemporary), ...environment }, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { process.stderr.write(`[process:error] ${error.message}\n`); reject(error); });
  child.on('close', (code, signal) => { process.stderr.write(`[process:finish] exit=${code ?? 'null'} signal=${signal ?? 'none'}\n`); code === 0 && !signal ? resolveRun() : reject(new Error(`clean-room command failed with ${signal ?? `exit code ${code}`}`)); });
});
try {
  await mkdir(project, { recursive: true });
  const excluded = new Set(['.git', 'node_modules', '.agent-harness-data', '.agent-harness-cache', '.tmp']);
  for (const name of await readdir(source)) {
    if (excluded.has(name)) continue;
    await cp(resolve(source, name), resolve(project, name), { recursive: true });
  }
  await mkdir(processTemporary, { recursive: true });
  await run(['scripts/check-project.mjs']);
  const discoverTests = async (directory, prefix = 'test') => (await Promise.all((await readdir(directory, { withFileTypes: true })).map(async entry => entry.isDirectory() ? discoverTests(resolve(directory, entry.name), `${prefix}/${entry.name}`) : entry.name.endsWith('.test.mjs') ? [`${prefix}/${entry.name}`] : []))).flat();
  const tests = (await discoverTests(resolve(project, 'test'))).sort();
  await run(['--test', '--test-isolation=none', '--test-concurrency=1', ...tests]);
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('check:clean-room must be started through npm so npm_execpath is available.');
  const npmEnvironment = { NPM_CONFIG_CACHE: resolve(project, '.agent-harness-cache', 'npm'), NPM_CONFIG_LOGS_DIR: resolve(project, '.tmp', 'npm-logs'), NPM_CONFIG_LOGS_MAX: '0', NPM_CONFIG_UPDATE_NOTIFIER: 'false' };
  await run([npmCli, 'pack', '--pack-destination', temporary], { cwd: source, environment: npmEnvironment });
  const archive = (await readdir(temporary)).find(name => name.endsWith('.tgz'));
  if (!archive) throw new Error('npm pack did not produce an archive.');
  const deployment = resolve(temporary, 'standalone-deployment');
  await mkdir(deployment, { recursive: true });
  await writeFile(resolve(deployment, 'package.json'), '{"name":"agent-harness-standalone-deployment","private":true,"type":"module"}\n', 'utf8');
  await run([npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--save=false', resolve(temporary, archive)], { cwd: deployment, environment: npmEnvironment });
  const setupProbe = `import { resolve } from 'node:path'; import { createHarness, ExtensionRegistry, initializeHarnessInstallation } from 'agent-harness'; let rejected = false; try { await createHarness(); } catch (error) { rejected = error.code === 'HARNESS_CONTROL_ROOT_REQUIRED'; } if (!rejected) throw new Error('packaged runtime accepted an implicit node_modules control root'); const controlRoot = process.cwd(); await initializeHarnessInstallation({ controlRoot }); const dataRoot = resolve(controlRoot, '.agent-harness-data'); const registry = new ExtensionRegistry({ controlRoot, dataRoot }); const receipt = await registry.register('agent-harness/consumers/cardworld-engine', { expectedRevision: 0, commandId: 'clean-room-install', authorityDecision: { actor: 'clean-room-test', decision: 'approved' } }); if (!receipt.digest) throw new Error('packaged extension was not bound to an artifact digest'); const harness = await createHarness({ controlRoot, dataRoot }); if (harness.controlRoot !== controlRoot || harness.extensionSet.installed.length !== 0) throw new Error('packaged standalone control root is invalid');`;
  const restartProbe = `import { rm } from 'node:fs/promises'; import { resolve } from 'node:path'; import { createHarness, ExtensionRegistry } from 'agent-harness'; const controlRoot = process.cwd(); const dataRoot = resolve(controlRoot, '.agent-harness-data'); const registry = new ExtensionRegistry({ controlRoot, dataRoot }); const extensions = await registry.loadInstalled(); if (extensions.length !== 1 || extensions[0].id !== 'cardworld-engine-profile' || !extensions[0].digest) throw new Error('registered extension did not survive a process restart'); const harness = await createHarness({ controlRoot, dataRoot, extensions }); if (harness.extensionSet.installed[0]?.digest !== extensions[0].digest) throw new Error('restarted Harness did not install the registered artifact'); await rm(dataRoot, { recursive: true, force: true });`;
  await run(['--input-type=module', '--eval', setupProbe], { cwd: deployment });
  await run(['--input-type=module', '--eval', "import { extensionPack } from 'agent-harness/extensions/legacy-compat'; if (extensionPack.id !== 'legacy-compatibility' || extensionPack.recoveryImporters.length !== 2) throw new Error('packaged Legacy Importer integration is missing');"], { cwd: deployment });
  await run(['--input-type=module', '--eval', restartProbe], { cwd: deployment });
  console.log(JSON.stringify({ ok: true, source, cleanRoom: project, note: 'temporary clean room removed after verification' }, null, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
  await rmdir(scratch).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
  await rmdir(resolve(source, '.tmp')).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
  for (const path of [resolve(source, '.agent-harness-cache', 'npm'), resolve(source, '.agent-harness-cache')]) await rmdir(path).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
}
