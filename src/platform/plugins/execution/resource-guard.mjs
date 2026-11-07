import { spawn } from 'node:child_process';
import { mkdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert } from '../../../common/errors.mjs';
import { executionHealth } from '../../../common/execution-health.mjs';
import { createProcessLog } from './process-log.mjs';

const MiB = 1024 * 1024;
export const SCRIPT_RESOURCE_LIMITS = Object.freeze({ memoryBytes: 512 * MiB, cpuPercent: 25,
  maxProcesses: 4, timeoutMs: 0, maxOutputBytes: MiB, maxInputBytes: 32 * MiB, maxInputFiles: 128, maxScriptBytes: 128 * 1024 });
const maximum = { ...SCRIPT_RESOURCE_LIMITS, memoryBytes: 8 * 1024 * MiB, cpuPercent:50, timeoutMs: 2147468647, maxProcesses: 32,
  maxOutputBytes:4*MiB,maxLogBytes:256*MiB,maxInputFiles:1000000,maxInputBytes:16*1024*MiB };
export const resolveResourceLimits = (input = {}) => {
  const policy = { ...SCRIPT_RESOURCE_LIMITS, ...input };
  for (const [key, value] of Object.entries(policy)) assert(Object.hasOwn(maximum, key)
    && Number.isSafeInteger(value) && (key === 'timeoutMs' ? value >= 0 : value > 0) && value <= maximum[key], 'RESOURCE_POLICY_INVALID', `Invalid or excessive ${key} resource limit.`);
  return policy;
};

// One common lock for Gates and Agent scripts, across all projects using this installation.
// Never steal a stale lock: a missing owner does not prove its child tree has stopped.
export const acquireResourceSlot = async root => {
  const directory = resolve(root, 'resource-slot');
  await mkdir(root, { recursive: true });
  try { await mkdir(directory); }
  catch (error) { if (error.code === 'EEXIST') throw Object.assign(new Error('Another bounded process owns the resource slot; serialize work. Inspect a stale owner before recovery.'), { code: 'RESOURCE_SLOT_BUSY' }); throw error; }
  try { await writeFile(resolve(directory, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx' }); }
  catch (error) { await rmdir(directory).catch(() => {}); throw error; }
  return async () => {
    const { unlink } = await import('node:fs/promises');
    await unlink(resolve(directory, 'owner.json'));
    await rmdir(directory);
  };
};

export const prepareResourceLaunch = (launch, input = {}, host = { platform: process.platform, available: freemem(), total: totalmem() }) => {
  const limits = resolveResourceLimits(input);
  assert(host.platform === 'win32', 'RESOURCE_SUPERVISOR_UNAVAILABLE', 'This resource supervisor requires Windows Job Objects; do not run scripts without an equivalent OS supervisor.');
  const reserve = Math.max(1024 * MiB, Math.ceil(host.total * 0.2));
  assert(host.available >= reserve + limits.memoryBytes, 'RESOURCE_HOST_HEADROOM_LOW', 'Insufficient host memory headroom; defer work rather than reduce the host reserve.');
  assert(typeof launch.executable === 'string' && Array.isArray(launch.args) && launch.args.every(arg => typeof arg === 'string'), 'RESOURCE_LAUNCH_INVALID', 'A structured executable and string argument array are required.');
  const executable = isAbsolute(launch.executable) ? launch.executable : (launch.environment?.PATH ?? process.env.PATH ?? '').split(delimiter)
    .flatMap(directory => [resolve(directory, launch.executable), resolve(directory, `${launch.executable}.exe`)])
    .find(path => existsSync(path));
  assert(executable, 'RESOURCE_EXECUTABLE_MISSING', `Executable not found: ${launch.executable}`);
  const childTemporary = Object.fromEntries(['TEMP', 'TMP', 'TMPDIR'].flatMap(name => {
    const value = launch.environment?.[name];
    return value && !/^c:[\\/]/i.test(value) ? [[name, value]] : [];
  }));
  const body = { executable, args: launch.args, cwd: launch.cwd, ...limits, parentPid: process.pid, childTemporary };
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64');
  assert(encoded.length < 24000, 'RESOURCE_LAUNCH_TOO_LARGE', 'Command is too large; move data into bounded input files and split work.');
  assert(process.env.SystemRoot, 'RESOURCE_SUPERVISOR_UNAVAILABLE', 'Windows system runtime location is unavailable.');
  return { executable: resolve(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./windows-resource-job.ps1', import.meta.url)), '-LaunchBase64', encoded],
    cwd: launch.cwd, environment: { ...launch.environment, OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1', NUMEXPR_NUM_THREADS: '1', CARGO_BUILD_JOBS: '1' }, limits };
};

export const runResourceBounded = async ({ launch, limits, resourceRoot, onSpawn = () => {}, onProgress = () => {} }) => {
  const prepared = prepareResourceLaunch(launch, limits);
  const release = await acquireResourceSlot(resourceRoot);
  const supervisorTemporary = resolve(resourceRoot, 'resource-slot', 'supervisor-temp');
  let log;
  try {
    await mkdir(supervisorTemporary);
    if(prepared.limits.maxLogBytes) log=await createProcessLog(resourceRoot,prepared.limits.maxLogBytes);
    return await new Promise(resolveRun => {
      const child = spawn(prepared.executable, prepared.args, { cwd: prepared.cwd, env: { ...prepared.environment,
        TEMP: supervisorTemporary, TMP: supervisorTemporary, TMPDIR: supervisorTemporary }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', bytes = 0, environmentError = null;
      const stop = (code, message) => { environmentError ??= { code, message }; child.kill(); };
      const consume = (chunk, stream) => {
        const remaining = Math.max(0, prepared.limits.maxOutputBytes - bytes);
        bytes += chunk.length;
        const text = chunk.subarray(0, remaining).toString();
        if (stream === 'stdout') stdout += text; else stderr += text;
        if (text) onProgress({ phase: 'output', stream, text });
        if(log) {
          try { if(!log.write(stream,chunk)) stop('PROCESS_LOG_LIMIT','Durable process log reached its disk quota.'); }
          catch(error) { stop('PROCESS_LOG_WRITE_FAILED',error.message); }
        } else if (bytes > prepared.limits.maxOutputBytes) stop('PROCESS_OUTPUT_LIMIT', 'Output exceeded its budget; split work and emit compact summaries.');
      };
      child.stdout.on('data', chunk => consume(chunk, 'stdout'));
      child.stderr.on('data', chunk => consume(chunk, 'stderr'));
      // The OS supervisor has its own clock; this also bounds supervisor startup.
      const timer = prepared.limits.timeoutMs > 0 ? setTimeout(() => stop('PROCESS_RESOURCE_TIMEOUT', 'Process reached its explicitly configured deadline.'), prepared.limits.timeoutMs + 15000) : null;
      // Observation is not a deadline. A quiet but living process remains visible.
      const observedStart = Date.now();
      const observer = setInterval(() => onProgress({ phase: 'process-observation', processId: child.pid ?? null,
        outputBytes: bytes, state: environmentError ? 'stopping' : 'running', progressVerified: false,
        health: executionHealth({ state: 'running', startedAt: observedStart, observedAt: Date.now() }) }), 30000);
      child.on('error', error => { environmentError = { code: error.code ?? 'RESOURCE_SPAWN_FAILED', message: error.message }; });
      child.on('close', (exitCode, signal) => {
        clearTimeout(timer);
        clearInterval(observer);
        if (exitCode === 124) environmentError ??= { code: 'PROCESS_RESOURCE_TIMEOUT', message: 'Supervisor stopped the process tree at its time limit.' };
        if (exitCode === 125) environmentError ??= { code: 'RESOURCE_SUPERVISOR_FAILED', message: 'OS resource isolation failed; no unguarded retry is allowed.' };
        resolveRun({ exitCode, signal, stdout, stderr, environmentError,
          resourceReceipt: { policy: 'bounded-script/1', limits: prepared.limits, outputBytes: bytes,
            displayTruncated:bytes>prepared.limits.maxOutputBytes,...(log?{logs:log.finish()}:{}), supervised: true, status: exitCode === 0 && !environmentError ? 'passed' : 'failed' } });
      });
      onSpawn(child);
      onProgress({ phase: 'process-started', processId: child.pid ?? null, resourcePolicy: 'bounded-script/1' });
    });
  } finally {
    await rm(supervisorTemporary, { recursive: true, force: true });
    await release();
  }
};

export const readBoundedJson = async (path, maxBytes) => {
  const { open } = await import('node:fs/promises');
  const file = await open(path, 'r');
  try {
    assert((await file.stat()).size <= maxBytes, 'SCRIPT_REQUEST_TOO_LARGE', 'Request exceeds its byte budget; split it.');
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    assert(bytesRead <= maxBytes, 'SCRIPT_REQUEST_TOO_LARGE', 'Request grew beyond its budget.');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally { await file.close(); }
};
