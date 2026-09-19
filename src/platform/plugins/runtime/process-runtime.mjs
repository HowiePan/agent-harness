import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { newId } from '../../../common/canonical.mjs';
import { assert } from '../../../common/errors.mjs';
import { envelope } from '../contracts.mjs';
import { createManagedOutputSession, DEFAULT_PROCESS_OUTPUTS, prepareSandboxLaunch, replaceOutputTokens } from '../execution/managed-output.mjs';

export const createProcessRuntime = ({ manifest, executable, args = [], cwd = process.cwd(), environment = {}, allowedExecutables = [executable], temporaryRoot, controlRoot, outputDeclarations = manifest.execution?.outputs ?? DEFAULT_PROCESS_OUTPUTS, sandbox = null, sandboxMode = manifest.execution?.sandbox?.mode ?? 'optional', monitorIntervalMs = 100 }) => {
  assert(allowedExecutables.includes(executable), 'PROCESS_EXECUTABLE_DENIED', 'Process Runtime executable is not allowlisted.', { executable });
  const processes = new Map();
  const results = new Map();
  const completions = new Map();
  const outputSessions = new Map();
  const outputReceipts = new Map();
  const sandboxReceipts = new Map();
  return {
    async spawn(packet) {
      const agentId = newId('process-agent');
      const session = createManagedOutputSession({ root: temporaryRoot, controlRoot, operationId: agentId, declarations: outputDeclarations });
      outputSessions.set(agentId, session);
      try {
        const prepared = await session.prepare();
        const requestedLaunch = { executable, args: args.map(value => replaceOutputTokens(value, session.paths)), cwd: resolve(cwd), environment: { ...process.env, ...environment, ...prepared.environment } };
        const sandboxed = await prepareSandboxLaunch({ sandbox, mode: sandboxMode, launch: requestedLaunch });
        sandboxReceipts.set(agentId, sandboxed.receipt);
        const child = spawn(sandboxed.launch.executable, sandboxed.launch.args, { cwd: sandboxed.launch.cwd, env: sandboxed.launch.environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        processes.set(agentId, child);
        session.monitor(child, { intervalMs: monitorIntervalMs });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', chunk => { stdout += chunk; });
        child.stderr?.on('data', chunk => { stderr += chunk; });
        const completion = new Promise(resolveCompletion => {
          let settled = false;
          const settle = value => {
            if (settled) return;
            settled = true;
            results.set(agentId, value);
            resolveCompletion(value);
          };
          child.on('error', error => settle({ exitCode: null, signal: null, stdout, stderr, environmentError: { code: error.code ?? 'SPAWN_FAILED', message: error.message } }));
          child.on('close', (exitCode, signal) => settle({ exitCode, signal, stdout, stderr }));
        });
        completions.set(agentId, completion);
        child.stdin?.write(`${JSON.stringify(packet)}\n`);
        return envelope(manifest, 'receipt', { operation: 'spawn', agentId, transportReceipt: { runtimePluginId: manifest.id, pid: child.pid ?? null, managedOutputRoot: session.operationRoot, sandbox: sandboxed.receipt, startedAt: new Date().toISOString() } });
      } catch (error) {
        outputReceipts.set(agentId, await session.finish({ reason: 'spawn-failed', sandboxReceipt: sandboxReceipts.get(agentId) ?? null }));
        outputSessions.delete(agentId);
        throw error;
      }
    },
    async wait({ agentId }) {
      const child = processes.get(agentId);
      if (child?.stdin?.writable) child.stdin.end();
      const result = await completions.get(agentId);
      assert(result, 'PROCESS_AGENT_NOT_FOUND', `Process agent not found: ${agentId}`);
      const session = outputSessions.get(agentId);
      const outputReceipt = await session.finish({ reason: 'process-finished', sandboxReceipt: sandboxReceipts.get(agentId) ?? null });
      outputReceipts.set(agentId, outputReceipt);
      outputSessions.delete(agentId);
      return envelope(manifest, 'event', { operation: 'wait', agentId, ...result, status: outputReceipt.status === 'budget-exceeded' ? 'failed' : result.exitCode === 0 ? 'completed' : 'failed', failureKind: outputReceipt.status === 'budget-exceeded' ? 'output-budget' : null, outputReceipt });
    },
    async send({ agentId, message }) {
      const child = processes.get(agentId);
      assert(child?.stdin?.writable, 'PROCESS_STDIN_CLOSED', `Process agent cannot receive input: ${agentId}`);
      child.stdin.write(`${JSON.stringify(message)}\n`);
      return envelope(manifest, 'receipt', { operation: 'send', agentId });
    },
    async heartbeat({ agentId }) {
      assert(processes.has(agentId), 'PROCESS_AGENT_NOT_FOUND', `Process agent not found: ${agentId}`);
      return envelope(manifest, 'receipt', { operation: 'heartbeat', agentId, observedAt: new Date().toISOString() });
    },
    async interrupt({ agentId }) {
      const child = processes.get(agentId);
      assert(child, 'PROCESS_AGENT_NOT_FOUND', `Process agent not found: ${agentId}`);
      const signalled = child.exitCode === null ? child.kill('SIGTERM') : false;
      return envelope(manifest, 'receipt', { operation: 'interrupt', agentId, signalled });
    },
    async cleanup({ agentId }) {
      const child = processes.get(agentId);
      if (child?.exitCode === null) {
        child.kill('SIGTERM');
        await completions.get(agentId);
      }
      if (outputSessions.has(agentId)) outputReceipts.set(agentId, await outputSessions.get(agentId).finish({ reason: 'cleanup', sandboxReceipt: sandboxReceipts.get(agentId) ?? null }));
      const outputReceipt = outputReceipts.get(agentId) ?? null;
      outputSessions.delete(agentId);
      processes.delete(agentId);
      results.delete(agentId);
      completions.delete(agentId);
      outputReceipts.delete(agentId);
      sandboxReceipts.delete(agentId);
      return envelope(manifest, 'receipt', { operation: 'cleanup', agentId, removed: true, outputReceipt });
    },
  };
};
