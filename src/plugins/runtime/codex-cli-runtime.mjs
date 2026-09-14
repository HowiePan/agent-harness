import { readFile, writeFile } from 'node:fs/promises';
import { spawn as nodeSpawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId, sha256 } from '../../canonical.mjs';
import { assert } from '../../errors.mjs';
import { assertSchemaDefinition } from '../../json-schema.mjs';
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
  capabilities: ['spawn', 'wait', 'heartbeat', 'interrupt', 'structured-result', 'workspace-shared', 'managed-outputs', 'headless'],
  permissions: ['agent.conversation', 'process.spawn', 'workspace.read', 'workspace.write'],
  execution: { outputs: CODEX_OUTPUTS, sandbox: { mode: 'required' } },
});

export const CODEX_ISOLATED_RUNTIME_MANIFEST = Object.freeze({
  id: 'codex-isolated-runtime',
  kind: 'agent-runtime',
  version: '1.0.0',
  capabilities: ['spawn', 'wait', 'heartbeat', 'interrupt', 'structured-result', 'workspace-isolated', 'managed-outputs', 'headless'],
  permissions: ['agent.conversation', 'process.spawn', 'workspace.read', 'workspace.write'],
  execution: { outputs: CODEX_OUTPUTS, sandbox: { mode: 'required' } },
});

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const codexResultSchema = resolve(packageRoot, 'schemas', 'codex-runtime-result.schema.json');
const sandboxValues = new Set(['read-only', 'workspace-write', 'danger-full-access']);

/** Validate the stricter subset required by Codex Structured Outputs. */
export const validateCodexStructuredOutputSchema = schema => {
  try { assertSchemaDefinition(schema, 'Codex Runtime output Schema'); }
  catch (error) { assert(false, 'CODEX_OUTPUT_SCHEMA_INVALID', error.message, { cause: error.code }); }
  const visited = new Set();
  const resolveLocalReference = reference => {
    const [file, fragment = ''] = String(reference).split('#');
    if (file || !fragment.startsWith('/')) return null;
    return fragment.split('/').slice(1).reduce((value, segment) => value?.[segment.replaceAll('~1', '/').replaceAll('~0', '~')], schema);
  };
  const visit = rule => {
    if (!rule || typeof rule !== 'object' || visited.has(rule)) return;
    visited.add(rule);
    if (rule.$ref) {
      const target = resolveLocalReference(rule.$ref);
      if (target) visit(target);
      return;
    }
    if (rule.type === 'object') {
      const names = Object.keys(rule.properties ?? {}).sort();
      const required = [...(rule.required ?? [])].sort();
      assert(rule.additionalProperties === false, 'CODEX_OUTPUT_SCHEMA_INVALID', 'Every object in a Codex output Schema must set additionalProperties to false.');
      assert(required.length === names.length && required.every((name, index) => name === names[index]), 'CODEX_OUTPUT_SCHEMA_INVALID', 'Every Codex output Schema property must be required.');
      for (const value of Object.values(rule.properties ?? {})) visit(value);
    }
    for (const value of Object.values(rule.$defs ?? {})) visit(value);
    if (rule.items) visit(rule.items);
    for (const value of rule.anyOf ?? []) visit(value);
  };
  visit(schema);
  return schema;
};

/**
 * Adapt the authoritative schema to the narrower schema dialect accepted by
 * Codex Structured Outputs. Uniqueness remains enforced by Harness after the
 * Runtime returns its result; the provider only needs the shape constraints.
 */
export const adaptCodexStructuredOutputSchema = schema => {
  if (Array.isArray(schema)) return schema.map(adaptCodexStructuredOutputSchema);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema)
    .filter(([key]) => key !== 'uniqueItems')
    .map(([key, value]) => [key, adaptCodexStructuredOutputSchema(value)]));
};

export const resolveCodexExecutionPolicy = (config = {}) => {
  const sandbox = config.sandbox ?? 'workspace-write';
  assert(sandboxValues.has(sandbox), 'CODEX_SANDBOX_INVALID', `Unsupported Codex sandbox: ${sandbox}`);
  assert(sandbox !== 'danger-full-access' || config.allowDangerFullAccess === true, 'CODEX_DANGER_SANDBOX_DENIED', 'danger-full-access requires an explicit Project policy opt-in.');
  assert(config.approveForMe === undefined || typeof config.approveForMe === 'boolean', 'CODEX_APPROVAL_POLICY_INVALID', 'approveForMe must be a boolean when configured.');
  const approveForMe = config.approveForMe === true;
  assert(!approveForMe || sandbox === 'workspace-write', 'CODEX_APPROVAL_SANDBOX_CONFLICT', 'approveForMe requires workspace-write and cannot be combined with another sandbox mode.');
  return {
    sandbox,
    approvalMode: approveForMe ? 'approve-for-me' : 'sandbox-only',
    cliArgs: approveForMe ? ['--approve-for-me'] : ['--sandbox', sandbox],
  };
};

export const buildCodexPrompt = packet => `You are an execution Runtime controlled by Agent Harness.

Complete exactly the supplied Feature inside the current workspace. Treat the Feature allowedPaths and forbiddenPaths as hard boundaries. Do not edit Harness Authority, Evidence, Dispatch, Lease, or Receipt data. Feature steps are ordered and share one logical attempt. For quality review Findings, report the affectedPaths, symbols, contracts, generatedOutputs, and conflictKeys needed to safely schedule independent repair Features. For normal development work, report followUpFeatures when the work decomposes into independent scoped tasks; each item must include its ID, acceptance, allowedPaths, forbiddenPaths, dependsOn, symbols, contracts, generatedOutputs, and conflictKeys.

Return only the structured business result required by the provided JSON Schema. Include an accurate changedFiles array using workspace-relative forward-slash paths. If the Feature cannot be completed, return status "blocked" or "failed" with a stable failureClass and blocker summary. Do not claim completion without running the Feature acceptance checks.

Dispatch packet:
${JSON.stringify(packet, null, 2)}
`;

const parseEvents = text => text.split(/\r?\n/).filter(Boolean).flatMap(line => {
  try { return [JSON.parse(line)]; } catch { return []; }
});

const parseEmbeddedJson = value => {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
};

const providerFailureFromEvents = events => {
  for (const event of events) {
    if (!['error', 'turn.failed', 'item.completed'].includes(event.type)) continue;
    const item = event.error ?? event.item ?? event;
    const embedded = parseEmbeddedJson(item?.message ?? event.message);
    const error = embedded?.error ?? embedded;
    if (!error || typeof error !== 'object') continue;
    const providerCode = error.code ?? error.type ?? null;
    const message = error.message ?? event.message ?? 'Codex provider request failed.';
    if (!providerCode && !message) continue;
    const code = providerCode === 'invalid_json_schema'
      ? 'CODEX_OUTPUT_SCHEMA_INVALID'
      : `CODEX_CLI_${String(providerCode ?? 'PROVIDER_ERROR').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
    return {
      code,
      failureClass: code === 'CODEX_OUTPUT_SCHEMA_INVALID' ? 'runtime-contract' : 'runtime-provider',
      message: String(message),
      details: { providerCode, parameter: error.param ?? null, eventType: event.type },
    };
  }
  return null;
};

export const createCodexCliRuntime = ({
  resolveProject,
  runtimeRoot,
  controlRoot,
  executable = 'codex',
  executableArgs = [],
  schemaPath = codexResultSchema,
  spawnProcess = nodeSpawn,
  promptBuilder = buildCodexPrompt,
  manifest = CODEX_CLI_RUNTIME_MANIFEST,
  workspaceProvider = null,
}) => {
  assert(typeof resolveProject === 'function', 'CODEX_PROJECT_RESOLVER_REQUIRED', 'Codex CLI Runtime requires a Project resolver.');
  const controlledRuntimeRoot = assertHarnessWritePath(runtimeRoot, 'Codex Runtime root', controlRoot);
  const tasks = new Map();
  const loadOutputSchema = async () => {
    let schema;
    try { schema = JSON.parse(await readFile(resolve(schemaPath), 'utf8')); }
    catch (error) { assert(false, 'CODEX_OUTPUT_SCHEMA_INVALID', `Codex Runtime output Schema could not be loaded: ${error.message}`, { cause: error.code ?? 'SCHEMA_READ_FAILED' }); }
    const validatedSchema = validateCodexStructuredOutputSchema(schema);
    return { source: validatedSchema, provider: adaptCodexStructuredOutputSchema(validatedSchema) };
  };
  return {
    async spawn(packet) {
      const project = await resolveProject(packet.projectId);
      const config = project.policy?.runtimeConfigs?.[manifest.id] ?? {};
      assert((project.policy?.runtimePlugins ?? [manifest.id]).includes(manifest.id), 'PROJECT_RUNTIME_DENIED', `Project ${project.id} does not allow ${manifest.id}.`);
      const executionPolicy = resolveCodexExecutionPolicy(config);
      const { sandbox, approvalMode } = executionPolicy;
      const { source: outputSchema, provider: providerOutputSchema } = await loadOutputSchema();
      const agentId = newId('codex-agent');
      const outputSession = createManagedOutputSession({ root: resolve(controlledRuntimeRoot, 'runtime', 'codex-cli'), controlRoot, operationId: agentId, declarations: config.outputs ?? manifest.execution?.outputs ?? CODEX_OUTPUTS });
      const directory = outputSession.operationRoot;
      let workspaceContext = null;
      let child = null;
      try {
        const managedOutputs = await outputSession.prepare();
        const processTemporary = outputSession.paths.temporary;
        const providerSchemaPath = resolve(processTemporary, 'codex-output-schema.json');
        await writeFile(providerSchemaPath, `${JSON.stringify(providerOutputSchema)}\n`, 'utf8');
        workspaceContext = workspaceProvider ? await workspaceProvider.prepare({ project, packet, agentId, runtimeDirectory: directory }) : null;
        const executionRoot = workspaceContext?.workspaceRoot ?? packet.workspace?.root ?? project.workspace.root;
        const lastMessagePath = resolve(outputSession.paths.debug, 'result.json');
        const eventsPath = resolve(outputSession.paths.debug, 'events.jsonl');
        const args = [...(config.executableArgs ?? executableArgs), 'exec', '--json', '--color', 'never', ...executionPolicy.cliArgs, '--cd', project.workspace.root, '--output-schema', providerSchemaPath, '--output-last-message', lastMessagePath];
        if (config.ephemeral !== false) args.push('--ephemeral');
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
        const sandboxReceipt = { mode: sandbox, approvalMode, requested: true, applied: false, providerId: manifest.id };
        tasks.set(agentId, { child, completion, stdout: () => stdout, stderr: () => stderr, lastMessagePath, eventsPath, packetDigest: packet.packetDigest ?? null, workspaceContext, result: null, outputSession, stopOutputMonitor, sandboxReceipt, outputSchemaDigest: sha256(JSON.stringify(outputSchema)) });
        child.stdin?.end(promptBuilder(structuredClone(packet)));
        return envelope(manifest, 'receipt', { operation: 'spawn', agentId, transportReceipt: { runtimePluginId: manifest.id, pid: child.pid ?? null, sandbox, approvalMode, managedOutputRoot: directory, managedOutputs: managedOutputs.outputs, workspaceRoot: executionRoot, sourceWorkspaceRoot: packet.workspace?.root ?? project.workspace.root, startedAt: new Date().toISOString() } });
      } catch (error) {
        if (child?.exitCode === null) child.kill('SIGTERM');
        if (workspaceProvider && workspaceContext) await workspaceProvider.discard(workspaceContext).catch(() => {});
        await outputSession.finish({ reason: 'spawn-failed', sandboxReceipt: { mode: sandbox, approvalMode, requested: true, applied: false, providerId: manifest.id } }).catch(() => {});
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
      task.sandboxReceipt = { ...task.sandboxReceipt, applied: Boolean(threadId) };
      const stderrDigest = sha256(stderr);
      const providerError = providerFailureFromEvents(events);
      const startupError = !threadId && (completion.error || completion.exitCode !== 0)
        ? {
            code: completion.error ? 'CODEX_CLI_SPAWN_FAILED' : 'CODEX_CLI_STARTUP_FAILED',
            message: completion.error ? 'Codex CLI process could not be started.' : `Codex CLI exited before starting the agent session (exit ${completion.exitCode}).`,
            details: { exitCode: completion.exitCode, signal: completion.signal, stderrDigest },
          }
        : null;
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
      return envelope(manifest, 'event', { operation: 'wait', agentId, status, exitCode: completion.exitCode, signal: completion.signal, processError: completion.error, startupError, providerError, resultError, result, threadId, eventCount: events.length, events, stdout, eventsPath: task.eventsPath, eventsDigest: sha256(stdout), stderr, stderrDigest, outputSchemaDigest: task.outputSchemaDigest, outputSnapshot, sandboxReceipt: task.sandboxReceipt, completedAt: new Date().toISOString() });
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
