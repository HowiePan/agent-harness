import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { digestJson, sha256 } from '../../../common/canonical.mjs';
import { assert } from '../../../common/errors.mjs';
import { assertInside } from '../../../common/paths.mjs';
import { envelope } from '../contracts.mjs';
import { createManagedOutputSession, DEFAULT_PROCESS_OUTPUTS, prepareSandboxLaunch, replaceOutputTokens } from '../execution/managed-output.mjs';

const run = ({ executable, args, cwd, env, timeoutMs, onSpawn, onProgress = null }) => new Promise(resolveRun => {
  const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  onSpawn(child);
  onProgress?.({ phase: 'process-started', processId: child.pid ?? null });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { const text = String(chunk); stdout += text; onProgress?.({ phase: 'output', stream: 'stdout', text }); });
  child.stderr.on('data', chunk => { const text = String(chunk); stderr += text; onProgress?.({ phase: 'output', stream: 'stderr', text }); });
  const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
  child.on('error', error => { clearTimeout(timer); onProgress?.({ phase: 'process-error', code: error.code ?? 'SPAWN_FAILED', message: error.message }); resolveRun({ exitCode: null, signal: null, stdout, stderr, environmentError: { code: error.code ?? 'SPAWN_FAILED', message: error.message } }); });
  child.on('close', (exitCode, signal) => { clearTimeout(timer); onProgress?.({ phase: 'process-finished', exitCode, signal }); resolveRun({ exitCode, signal, stdout, stderr }); });
});

export const createProcessGateExecutor = ({ manifest, workspaceRoot, allowlist, baseEnvironment = {}, temporaryRoot, controlRoot, outputDeclarations = manifest.execution?.outputs ?? DEFAULT_PROCESS_OUTPUTS, sandbox = null, resolveSandbox = null, sandboxMode = manifest.execution?.sandbox?.mode ?? 'optional', monitorIntervalMs = 100, onProgress = null }) => ({
  async execute(spec) {
    assert(typeof onProgress === 'function', 'PROCESS_PROGRESS_OBSERVER_REQUIRED', 'Process Gate execution requires a live progress observer.');
    const allowed = allowlist.find(item => item.id === spec.commandId);
    assert(allowed, 'GATE_COMMAND_DENIED', `Gate command is not allowlisted: ${spec.commandId}`);
    const cwd = assertInside(workspaceRoot, resolve(workspaceRoot, spec.cwd ?? allowed.cwd ?? '.'), 'gate cwd');
    const declarations = spec.outputs ?? allowed.outputs ?? outputDeclarations;
    const session = createManagedOutputSession({ root: temporaryRoot, controlRoot, operationId: `${spec.id}-${Date.now()}`, declarations });
    const startedAt = new Date().toISOString();
    let result;
    let outputReceipt;
    let sandboxReceipt = null;
    try {
      onProgress({ gateId: spec.id, phase: 'started', commandId: spec.commandId, startedAt });
      const prepared = await session.prepare();
      const requestedLaunch = { executable: allowed.executable, args: [...(allowed.args ?? []), ...(spec.args ?? [])].map(value => replaceOutputTokens(value, session.paths)), cwd, environment: { ...process.env, ...baseEnvironment, ...(allowed.environment ?? {}), ...prepared.environment } };
      const selectedSandbox = resolveSandbox ? resolveSandbox({ spec, allowed }) : sandbox;
      const sandboxed = await prepareSandboxLaunch({ sandbox: selectedSandbox, mode: spec.sandboxMode ?? allowed.sandboxMode ?? sandboxMode, launch: requestedLaunch });
      sandboxReceipt = sandboxed.receipt;
      result = await run({ executable: sandboxed.launch.executable, args: sandboxed.launch.args, cwd: sandboxed.launch.cwd, env: sandboxed.launch.environment, timeoutMs: Number(spec.timeoutMs ?? allowed.timeoutMs ?? 300000), onSpawn: child => session.monitor(child, { intervalMs: monitorIntervalMs }), onProgress: event => onProgress({ gateId: spec.id, ...event }) });
    } catch (error) {
      result = { exitCode: null, signal: null, stdout: '', stderr: '', environmentError: { code: error.code ?? 'GATE_EXECUTION_FAILED', message: error.message } };
    } finally {
      outputReceipt = await session.finish({ reason: result ? 'gate-finished' : 'gate-failed', sandboxReceipt });
    }
    const finishedAt = new Date().toISOString();
    const status = outputReceipt.status === 'budget-exceeded' ? 'budget-exceeded' : result.environmentError || result.signal ? 'environment-failed' : result.exitCode === 0 ? 'passed' : 'failed';
    const payload = { operation: 'gate', gateId: spec.id, commandId: spec.commandId, status, exitCode: result.exitCode, signal: result.signal, environmentError: result.environmentError ?? null, stdout: result.stdout, stderr: result.stderr, outputDigest: sha256(`${result.stdout}\0${result.stderr}`), specDigest: digestJson(spec), outputReceipt, sandboxReceipt, startedAt, finishedAt };
    onProgress({ gateId: spec.id, phase: 'finished', status, exitCode: result.exitCode, signal: result.signal, finishedAt });
    return envelope(manifest, 'receipt', payload);
  },
});
