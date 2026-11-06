import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { acquireResourceSlot, prepareResourceLaunch, resolveResourceLimits, runResourceBounded } from '../src/platform/plugins/execution/resource-guard.mjs';
import { validateScriptRequest } from '../scripts/run-bounded-script.mjs';

const root = resolve('.tmp/resource-tests');
const fixture = async t => {
  await mkdir(root, { recursive: true });
  const path = await mkdtemp(resolve(root, 'case-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
};
test('preflight denies absent OS enforcement, excessive limits and low host headroom', () => {
  const launch = { executable: process.execPath, args: [], cwd: process.cwd() };
  assert.throws(() => resolveResourceLimits({ cpuPercent: 100 }), { code: 'RESOURCE_POLICY_INVALID' });
  assert.throws(() => prepareResourceLaunch(launch, {}, { platform: 'linux', available: 8e9, total: 16e9 }), { code: 'RESOURCE_SUPERVISOR_UNAVAILABLE' });
  assert.throws(() => prepareResourceLaunch(launch, {}, { platform: 'win32', available: 1e9, total: 16e9 }), { code: 'RESOURCE_HOST_HEADROOM_LOW' });
});
test('shared resource slot serializes processes and releases normally', async t => {
  const path = await fixture(t);
  const release = await acquireResourceSlot(path);
  await assert.rejects(acquireResourceSlot(path), { code: 'RESOURCE_SLOT_BUSY' });
  await release();
  await (await acquireResourceSlot(path))();
});
test('script preflight requires explicit bounded inputs, script and shard checkpoint', async t => {
  const path = await fixture(t), script = resolve(path, 'part.mjs');
  await writeFile(script, 'console.log("part")');
  const request = { schemaVersion: 'bounded-script/1', executable: process.execPath, cwd: path,
    script, args: [script], inputs: [script], shard: { id: 'one', checkpoint: 'part-result.json' } };
  assert.equal((await validateScriptRequest(request)).inputFiles, 1);
  await assert.rejects(validateScriptRequest({ ...request, inputs: Array(129).fill(script) }), { code: 'SCRIPT_SPLIT_REQUIRED' });
  await assert.rejects(validateScriptRequest({ ...request, args: ['-e', 'program'] }), { code: 'SCRIPT_ENTRY_REQUIRED' });
  await assert.rejects(validateScriptRequest({ ...request, shard: {} }), { code: 'SCRIPT_CHECKPOINT_REQUIRED' });
  await assert.rejects(validateScriptRequest({ ...request, inputs: [path], script: path, args: [path] }), { code: 'SCRIPT_INPUTS_INVALID' });
  await assert.rejects(validateScriptRequest({ ...request, limits: { maxInputBytes: 1 } }), { code: 'SCRIPT_SPLIT_REQUIRED' });
  await assert.rejects(validateScriptRequest({ ...request, limits: { memoryBytes: 1024 ** 3 } }), { code: 'SCRIPT_SPLIT_REQUIRED' });
});
test('Windows Job denies excess child processes and memory using tiny bounded fixtures', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const path = await fixture(t);
  const run = (program, limits) => runResourceBounded({ launch: { executable: process.execPath,
    args: ['-e', program], cwd: path, environment: process.env }, limits, resourceRoot: path });
  const count = await run('try{require("child_process").spawn(process.execPath,["-e",""],{stdio:"ignore"}).on("error",()=>console.log("denied"))}catch(e){console.log("denied")}', { maxProcesses: 1 });
  assert.equal(count.exitCode, 0, count.stderr);
  assert.match(count.stdout, /denied/);
  const memory = await run('const a=[];for(let i=0;i<32;i++)a.push(Buffer.alloc(8*1024*1024,1));console.log("unexpected-success")',
    { memoryBytes: 96 * 1024 * 1024, timeoutMs: 1000, maxOutputBytes: 16384 });
  assert.notEqual(memory.exitCode, 0);
  assert.doesNotMatch(memory.stdout, /unexpected-success/);
});
test('Windows Job executes a tiny child and enforces time, output and tree lifetime', { skip: process.platform !== 'win32', timeout: 45000 }, async t => {
  const path = await fixture(t);
  const run = (program, limits = {}) => runResourceBounded({ launch: { executable: process.execPath,
    args: ['-e', program], cwd: path, environment: process.env }, limits, resourceRoot: path });
  const success = await run('console.log("tiny-ok")');
  assert.equal(success.exitCode, 0, success.stderr);
  assert.match(success.stdout, /tiny-ok/);
  assert.equal(success.resourceReceipt.limits.cpuPercent, 25);
  const timeout = await run('setInterval(()=>{},1000)', { timeoutMs: 200 });
  assert.equal(timeout.environmentError?.code, 'PROCESS_RESOURCE_TIMEOUT', timeout.stderr);
  const output = await run('console.log("x".repeat(2048));setInterval(()=>{},1000)', { maxOutputBytes: 128 });
  assert.equal(output.environmentError?.code, 'PROCESS_OUTPUT_LIMIT');
  assert.ok(Buffer.byteLength(output.stdout + output.stderr) <= 128);
  const tree = await run('const c=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log(c.pid);c.unref()');
  assert.equal(tree.exitCode, 0, tree.stderr);
  const pid = Number(tree.stdout.trim());
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid, 0));
});
