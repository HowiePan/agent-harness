import { lstat, mkdir, readdir, rm, rmdir } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { digestJson } from '../../canonical.mjs';
import { assert } from '../../errors.mjs';
import { safeSegment } from '../../paths.mjs';
import { assertHarnessWritePath } from '../../write-boundary.mjs';

export const OUTPUT_RETENTIONS = Object.freeze(['ephemeral', 'evidence-then-delete', 'cache', 'artifact']);
export const DEFAULT_PROCESS_OUTPUTS = Object.freeze([
  Object.freeze({ id: 'temporary', retention: 'ephemeral', environment: ['TEMP', 'TMP', 'TMPDIR'], maxBytes: 64 * 1024 * 1024, maxFiles: 10_000 }),
]);

export const validateOutputDeclarations = declarations => {
  assert(Array.isArray(declarations) && declarations.length > 0, 'OUTPUT_DECLARATIONS_REQUIRED', 'A process plugin requires at least one managed output declaration.');
  const ids = new Set();
  return declarations.map(input => {
    const value = structuredClone(input);
    const id = safeSegment(value.id, 'output id');
    assert(!ids.has(id), 'OUTPUT_ID_DUPLICATE', `Managed output ID is duplicated: ${id}`);
    ids.add(id);
    assert(OUTPUT_RETENTIONS.includes(value.retention), 'OUTPUT_RETENTION_INVALID', `Unsupported output retention: ${value.retention}`);
    assert(Number.isSafeInteger(value.maxBytes) && value.maxBytes > 0, 'OUTPUT_BYTE_BUDGET_INVALID', `Managed output ${id} requires a positive maxBytes budget.`);
    assert(Number.isSafeInteger(value.maxFiles) && value.maxFiles > 0, 'OUTPUT_FILE_BUDGET_INVALID', `Managed output ${id} requires a positive maxFiles budget.`);
    const environment = [...new Set(value.environment ?? [])].map(String);
    assert(environment.every(name => /^[A-Z_][A-Z0-9_]*$/i.test(name)), 'OUTPUT_ENVIRONMENT_INVALID', `Managed output ${id} contains an invalid environment variable.`);
    return Object.freeze({ id, retention: value.retention, environment, maxBytes: value.maxBytes, maxFiles: value.maxFiles });
  });
};

const usageOf = async root => {
  const usage = { files: 0, bytes: 0 };
  const visit = async path => {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const file = resolve(path, entry.name);
      if (entry.isDirectory()) await visit(file);
      else {
        const info = await lstat(file);
        usage.files += 1;
        usage.bytes += info.isFile() ? info.size : 0;
      }
    }
  };
  await visit(root);
  return usage;
};

const violationsFor = outputs => outputs.flatMap(output => [
  ...(output.usage.bytes > output.maxBytes ? [{ outputId: output.id, metric: 'bytes', limit: output.maxBytes, actual: output.usage.bytes }] : []),
  ...(output.usage.files > output.maxFiles ? [{ outputId: output.id, metric: 'files', limit: output.maxFiles, actual: output.usage.files }] : []),
]);

export const createManagedOutputSession = ({ root, controlRoot, operationId, declarations = DEFAULT_PROCESS_OUTPUTS, now = () => new Date().toISOString() }) => {
  const controlledRoot = assertHarnessWritePath(root, 'managed output root', controlRoot);
  const operation = safeSegment(operationId, 'operationId');
  const policy = validateOutputDeclarations(declarations);
  const operationRoot = assertHarnessWritePath(resolve(controlledRoot, operation), 'managed operation root', controlRoot);
  const paths = Object.fromEntries(policy.map(output => [output.id, resolve(operationRoot, output.id)]));
  const peakUsage = new Map(policy.map(output => [output.id, { files: 0, bytes: 0 }]));
  let monitor = null;
  let observedViolations = [];

  const inspect = async () => {
    const outputs = await Promise.all(policy.map(async output => {
      const usage = await usageOf(paths[output.id]);
      const prior = peakUsage.get(output.id);
      const peak = { files: Math.max(prior.files, usage.files), bytes: Math.max(prior.bytes, usage.bytes) };
      peakUsage.set(output.id, peak);
      return { ...output, path: paths[output.id], usage, peakUsage: peak };
    }));
    const violations = violationsFor(outputs);
    if (!observedViolations.length && violations.length) observedViolations = structuredClone(violations);
    return { outputs, violations };
  };

  return {
    operationId: operation,
    operationRoot,
    paths: Object.freeze(paths),
    async prepare() {
      await mkdir(operationRoot, { recursive: true });
      for (const output of policy) await mkdir(paths[output.id], { recursive: true });
      const environment = {};
      for (const output of policy) for (const name of output.environment) environment[name] = paths[output.id];
      return { operationId: operation, operationRoot, outputs: policy.map(output => ({ ...output, path: paths[output.id] })), environment };
    },
    inspect,
    monitor(child, { intervalMs = 100 } = {}) {
      assert(!monitor, 'OUTPUT_MONITOR_ALREADY_STARTED', `Output monitor already started: ${operation}`);
      let pending = Promise.resolve();
      const timer = setInterval(() => {
        pending = pending.then(async () => {
          const snapshot = await inspect();
          if (snapshot.violations.length && child.exitCode === null) child.kill('SIGTERM');
        }).catch(() => {});
      }, intervalMs);
      monitor = async () => { clearInterval(timer); await pending; return inspect(); };
      return monitor;
    },
    async finish({ reason = 'completed', sandboxReceipt = null } = {}) {
      const before = monitor ? await monitor() : await inspect();
      monitor = null;
      const cleanup = [];
      for (const output of before.outputs) {
        const remove = ['ephemeral', 'evidence-then-delete'].includes(output.retention);
        if (remove) await rm(output.path, { recursive: true, force: true });
        cleanup.push({ id: output.id, retention: output.retention, removed: remove });
      }
      await rmdir(operationRoot).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
      await rmdir(controlledRoot).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
      const remaining = await Promise.all(policy.map(async output => ({ id: output.id, ...await usageOf(paths[output.id]) })));
      const receipt = {
        protocolVersion: '1.0',
        operationId: operation,
        reason,
        status: observedViolations.length ? 'budget-exceeded' : 'cleaned',
        outputs: before.outputs.map(output => ({ id: output.id, retention: output.retention, maxBytes: output.maxBytes, maxFiles: output.maxFiles, usage: output.usage, peakUsage: output.peakUsage })),
        violations: observedViolations,
        cleanup,
        remaining,
        sandboxReceipt,
        finishedAt: now(),
      };
      receipt.receiptDigest = digestJson(receipt);
      return receipt;
    },
  };
};

export const replaceOutputTokens = (value, paths) => String(value).replace(/\{\{output:([A-Za-z0-9._-]+)\}\}/g, (_, id) => {
  assert(paths[id], 'OUTPUT_TOKEN_UNKNOWN', `Command references undeclared managed output: ${id}`);
  return paths[id];
});

export const prepareSandboxLaunch = async ({ sandbox = null, mode = 'optional', launch }) => {
  assert(['disabled', 'optional', 'required'].includes(mode), 'OS_SANDBOX_MODE_INVALID', `Unsupported OS sandbox mode: ${mode}`);
  if (mode === 'disabled') return { launch, receipt: { mode, applied: false, providerId: null } };
  if (!sandbox) {
    assert(mode !== 'required', 'OS_SANDBOX_REQUIRED', 'Project policy requires an OS sandbox provider for this process.');
    return { launch, receipt: { mode, applied: false, providerId: null } };
  }
  assert(sandbox.manifest?.kind === 'os-sandbox' && typeof sandbox.instance?.prepare === 'function', 'OS_SANDBOX_PROVIDER_INVALID', 'OS sandbox provider must be a validated os-sandbox plugin.');
  const response = await sandbox.instance.prepare(structuredClone(launch));
  assert(response?.type === 'receipt' && response.pluginId === sandbox.manifest.id && response.payload?.launch, 'OS_SANDBOX_RESPONSE_INVALID', 'OS sandbox provider returned an invalid launch receipt.');
  const prepared = response.payload.launch;
  assert(prepared.executable && Array.isArray(prepared.args) && prepared.cwd && isAbsolute(prepared.cwd) && prepared.environment && typeof prepared.environment === 'object', 'OS_SANDBOX_LAUNCH_INVALID', 'OS sandbox provider returned an invalid process launch definition.');
  for (const [name, value] of Object.entries(launch.environment)) assert(prepared.environment[name] === value, 'OS_SANDBOX_ENV_OVERRIDE', `OS sandbox provider may not override the locked process environment variable ${name}.`);
  return { launch: prepared, receipt: { mode, applied: true, providerId: sandbox.manifest.id, providerVersion: sandbox.manifest.version, details: response.payload.receipt ?? null } };
};

export const createCommandWrapperSandbox = ({ manifest, wrap }) => ({
  async prepare(launch) {
    assert(typeof wrap === 'function', 'OS_SANDBOX_WRAPPER_REQUIRED', 'Command-wrapper sandbox requires wrap().');
    const prepared = await wrap(structuredClone(launch));
    return { type: 'receipt', pluginId: manifest.id, pluginVersion: manifest.version, payload: { operation: 'prepare', launch: prepared.launch ?? prepared, receipt: prepared.receipt ?? null } };
  },
});
