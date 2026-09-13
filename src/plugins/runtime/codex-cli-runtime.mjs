import { readFile, writeFile } from 'node:fs/promises';
import { spawn as nodeSpawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId, sha256 } from '../../canonical.mjs';
import { assert } from '../../errors.mjs';
import { envelope } from '../contracts.mjs';
import { assertHarnessWritePath, temporaryEnvironment } from '../../write-boundary.mjs';
import { createManagedOutputSession } from '../execution/managed-output.mjs';

const CODEX_OUTPUTS = Object.freeze([
  Object.freeze({ id: 'temporary', retention: 'ephemeral', environment: ['TEMP', 'TMP', 'TMPDIR'], maxBytes: 256 * 1024 * 1024, maxFiles: 20_000 }),
  Object.freeze({ id: 'debug', retention: 'evidence-then-delete', environment: [], maxBytes: 64 * 1024 * 1024, maxFiles: 10_000 }),
  Object.freeze({ id: 'workspace', retention: 'ephemeral', environment: [], maxBytes: 2 * 1024 * 1024 * 1024, maxFiles: 200_000 }),
]);

export const CODEX_CLI_RUNTIME_MANIFEST = Object.freeze({
  id: 'codex-cli-runtime',
  kind: 'agent-runtime',
  version: '1.0.0',
  capabilities: ['spawn', 'wait', 'heartbeat', 'interrupt', 'structured-result', 'workspace-shared', 'managed-outputs'],
  permissions: ['agent.conversation', 'process.spawn', 'workspace.read', 'workspace.write'],
  execution: { outputs: CODEX_OUTPUTS, sandbox: { mode: 'required' } },
});

export const CODEX_ISOLATED_RUNTIME_MANIFEST = Object.freeze({
  id: 'codex-isolated-runtime',
  kind: 'agent-runtime',
  version: '1.0.0',
  capabilities: ['spawn', 'wait', 'heartbeat', 'interrupt', 'structured-result', 'workspace-isolated', 'managed-outputs'],
  permissions: ['agent.conversation', 'process.spawn', 'workspace.read', 'workspace.write'],
  execution: { outputs: CODEX_OUTPUTS, sandbox: { mode: 'required' } },
});

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const resultSchema = resolve(packageRoot, 'schemas', 'result.schema.json');
const sandboxValues = new Set(['read-only', 'workspace-write', 'danger-full-access']);

export const buildCodexPrompt = packet => `You are an execution Runtime controlled by Agent Harness.

Complete exactly the supplied Feature inside the current workspace. Treat the Feature allowedPaths and forbiddenPaths as hard boundaries. Do not edit Harness Authority, Evidence, Dispatch, Lease, or Receipt data. Feature steps are ordered and share one logical attempt.

Return only the structured business result required by the provided JSON Schema. Include an accurate changedFiles array using workspace-relative forward-slash paths. If the Feature cannot be completed, return status "blocked" or "failed" with a stable failureClass and blocker summary. Do not claim completion without running the Feature acceptance checks.

Dispatch packet:
${JSON.stringify(packet, null, 2)}
`;

const parseEvents = text => text.split(/\r?\n/).filter(Boolean).flatMap(line => {
  try { return [JSON.parse(line)]; } catch { return []; }
});

export const createCodexCliRuntime = ({
  resolveProject,
  runtimeRoot,
  controlRoot,
  executable = 'codex',
  executableArgs = [],
  schemaPath = resultSchema,
  spawnProcess = nodeSpawn,
  promptBuilder = buildCodexPrompt,
  manifest = CODEX_CLI_RUNTIME_MANIFEST,
  workspaceProvider = null,
}) => {
  assert(typeof resolveProject === 'function', 'CODEX_PROJECT_RESOLVER_REQUIRED', 'Codex CLI Runtime requires a Project resolver.');
  const controlledRuntimeRoot = assertHarnessWritePath(runtimeRoot, 'Codex Runtime root', controlRoot);
  const tasks = new Map();
  return {
    async spawn(packet) {
      const project = await resolveProject(packet.projectId);
      const config = project.policy?.runtimeConfigs?.[manifest.id] ?? {};
      assert((project.policy?.runtimePlugins ?? [manifest.id]).includes(manifest.id), 'PROJECT_RUNTIME_DENIED', `Project ${project.id} does not allow ${manifest.id}.`);
      const sandbox = config.sandbox ?? 'workspace-write';
      assert(sandboxValues.has(sandbox), 'CODEX_SANDBOX_INVALID', `Unsupported Codex sandbox: ${sandbox}`);
      assert(sandbox !== 'danger-full-access' || config.allowDangerFullAccess === true, 'CODEX_DANGER_SANDBOX_DENIED', 'danger-full-access requires an explicit Project policy opt-in.');
      const agentId = newId('codex-agent');
      const outputSession = createManagedOutputSession({ root: resolve(controlledRuntimeRoot, 'runtime', 'codex-cli'), controlRoot, operationId: agentId, declarations: config.outputs ?? manifest.execution?.outputs ?? CODEX_OUTPUTS });
      const directory = outputSession.operationRoot;
      let workspaceContext = null;
      let child = null;
      try {
        const managedOutputs = await outputSession.prepare();
        const processTemporary = outputSession.paths.temporary;
        workspaceContext = workspaceProvider ? await workspaceProvider.prepare({ project, packet, agentId, runtimeDirectory: directory }) : null;
        const executionRoot = workspaceContext?.workspaceRoot ?? project.workspace.root;
        const lastMessagePath = resolve(outputSession.paths.debug, 'result.json');
        const eventsPath = resolve(outputSession.paths.debug, 'events.jsonl');
        const args = [...(config.executableArgs ?? executableArgs), 'exec', '--json', '--color', 'never', '--sandbox', sandbox, '--cd', project.workspace.root, '--output-schema', resolve(schemaPath), '--output-last-message', lastMessagePath];
        if (config.ephemeral !== false) args.push('--ephemeral');
        if (config.approveForMe !== false) args.push('--approve-for-me');
        const routedModel = packet.execution?.modelRoute?.route?.model ?? config.model;
        if (routedModel) args.push('--model', String(routedModel));
        args.push('-');
        const cdIndex = args.indexOf('--cd');
        args[cdIndex + 1] = executionRoot;
        child = spawnProcess(config.executable ?? executable, args, { cwd: executionRoot, env: { ...process.env, ...temporaryEnvironment(processTemporary, controlRoot) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        const stopOutputMonitor = outputSession.monitor(child, { intervalMs: Number(config.outputMonitorIntervalMs ?? 100) });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', chunk => { stdout += chunk; });
        child.stderr?.on('data', chunk => { stderr += chunk; });
        const completion = new Promise(resolveCompletion => {
          let settled = false;
          const settle = value => { if (!settled) { settled = true; resolveCompletion(value); } };
          child.on('error', error => settle({ exitCode: null, signal: null, error: { code: error.code, message: error.message } }));
          child.on('close', (exitCode, signal) => settle({ exitCode, signal, error: null }));
        });
        const sandboxReceipt = { mode: sandbox, applied: true, providerId: manifest.id };
        tasks.set(agentId, { child, completion, stdout: () => stdout, stderr: () => stderr, lastMessagePath, eventsPath, packetDigest: packet.packetDigest ?? null, workspaceContext, result: null, outputSession, stopOutputMonitor, sandboxReceipt });
        child.stdin?.end(promptBuilder(structuredClone(packet)));
        return envelope(manifest, 'receipt', { operation: 'spawn', agentId, transportReceipt: { runtimePluginId: manifest.id, pid: child.pid ?? null, sandbox, managedOutputRoot: directory, managedOutputs: managedOutputs.outputs, workspaceRoot: executionRoot, sourceWorkspaceRoot: project.workspace.root, startedAt: new Date().toISOString() } });
      } catch (error) {
        if (child?.exitCode === null) child.kill('SIGTERM');
        if (workspaceProvider && workspaceContext) await workspaceProvider.discard(workspaceContext).catch(() => {});
        await outputSession.finish({ reason: 'spawn-failed', sandboxReceipt: { mode: sandbox, applied: false, providerId: manifest.id } }).catch(() => {});
        tasks.delete(agentId);
        throw error;
      }
    },

    async wait({ agentId }) {
      const task = tasks.get(agentId);
      assert(task, 'CODEX_AGENT_NOT_FOUND', `Codex CLI agent not found: ${agentId}`);
      const completion = await task.completion;
      const stdout = task.stdout();
      const stderr = task.stderr();
      await writeFile(task.eventsPath, stdout, 'utf8');
      const events = parseEvents(stdout);
      const threadId = events.find(event => event.type === 'thread.started')?.thread_id ?? null;
      let result = null;
      let resultError = null;
      try { result = JSON.parse(await readFile(task.lastMessagePath, 'utf8')); }
      catch (error) { resultError = { code: error.code ?? 'RESULT_PARSE_FAILED', message: error.message }; }
      if (result && workspaceProvider && !resultError) {
        try { await workspaceProvider.inspect(task.workspaceContext, result); }
        catch (error) { resultError = { code: error.code ?? 'ISOLATED_INSPECTION_FAILED', message: error.message, details: error.details }; result = null; }
      }
      const outputSnapshot = await task.stopOutputMonitor();
      if (outputSnapshot.violations.length) {
        resultError = { code: 'OUTPUT_BUDGET_EXCEEDED', message: 'Codex Runtime exceeded a managed output budget.', details: { violations: outputSnapshot.violations } };
        result = null;
      }
      task.result = result;
      const status = completion.exitCode === 0 && result ? 'completed' : 'failed';
      return envelope(manifest, 'event', { operation: 'wait', agentId, status, exitCode: completion.exitCode, signal: completion.signal, processError: completion.error, resultError, result, threadId, eventCount: events.length, events, eventsPath: task.eventsPath, eventsDigest: sha256(stdout), stderr, stderrDigest: sha256(stderr), outputSnapshot, sandboxReceipt: task.sandboxReceipt, completedAt: new Date().toISOString() });
    },

    async send({ agentId }) {
      assert(tasks.has(agentId), 'CODEX_AGENT_NOT_FOUND', `Codex CLI agent not found: ${agentId}`);
      return envelope(manifest, 'receipt', { operation: 'send', agentId, accepted: false, reason: 'codex-exec-is-single-turn' });
    },

    async integrate({ agentId }) {
      const task = tasks.get(agentId);
      assert(task && workspaceProvider && task.result, 'RUNTIME_INTEGRATION_UNAVAILABLE', `Runtime result cannot be integrated: ${agentId}`);
      const integrated = await workspaceProvider.integrate(task.workspaceContext, task.result);
      return envelope(manifest, 'receipt', { operation: 'integrate', agentId, ...integrated });
    },

    async discard({ agentId }) {
      const task = tasks.get(agentId);
      assert(task, 'CODEX_AGENT_NOT_FOUND', `Codex CLI agent not found: ${agentId}`);
      if (workspaceProvider && task.workspaceContext) await workspaceProvider.discard(task.workspaceContext);
      return envelope(manifest, 'receipt', { operation: 'discard', agentId });
    },

    async cleanup({ agentId }) {
      const task = tasks.get(agentId);
      assert(task, 'CODEX_AGENT_NOT_FOUND', `Codex CLI agent not found: ${agentId}`);
      if (task.child.exitCode === null) {
        task.child.kill('SIGTERM');
        await task.completion;
      }
      if (workspaceProvider && task.workspaceContext) await workspaceProvider.discard(task.workspaceContext);
      const outputReceipt = await task.outputSession.finish({ reason: 'cleanup', sandboxReceipt: task.sandboxReceipt });
      tasks.delete(agentId);
      return envelope(manifest, 'receipt', { operation: 'cleanup', agentId, removed: true, outputReceipt });
    },

    async heartbeat({ agentId }) {
      const task = tasks.get(agentId);
      assert(task, 'CODEX_AGENT_NOT_FOUND', `Codex CLI agent not found: ${agentId}`);
      return envelope(manifest, 'receipt', { operation: 'heartbeat', agentId, running: task.child.exitCode === null, observedAt: new Date().toISOString() });
    },

    async interrupt({ agentId }) {
      const task = tasks.get(agentId);
      assert(task, 'CODEX_AGENT_NOT_FOUND', `Codex CLI agent not found: ${agentId}`);
      const signalled = task.child.exitCode === null ? task.child.kill('SIGTERM') : false;
      return envelope(manifest, 'receipt', { operation: 'interrupt', agentId, signalled });
    },
  };
};
