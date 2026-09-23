import { digestJson, newId } from '../../../common/canonical.mjs';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { assert } from '../../../common/errors.mjs';
import { EXECUTION_CLASSES, assertExecutionClass } from '../../execution/boundary.mjs';
import { GateCache } from '../../../kernel/gate-cache.mjs';
import { PluginHost } from '../../plugins/host.mjs';
import { createProcessGateExecutor } from '../../plugins/gate/process-gate.mjs';
import { captureWorkspace } from '../../../common/workspace-snapshot.mjs';
import { DEFAULT_PROCESS_OUTPUTS } from '../../plugins/execution/managed-output.mjs';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, relative, resolve } from 'node:path';

const manifest = Object.freeze({ id: 'project-process-gates', kind: 'gate-executor', version: '1.0.0', capabilities: ['process', 'success-cache', 'fresh-final', 'managed-outputs'], permissions: ['gate.execute'], execution: { outputs: DEFAULT_PROCESS_OUTPUTS, sandbox: { mode: 'optional' } } });
const issuedGateSubmissions = new WeakSet();
const issuedGateInvocations = new WeakSet();
export const assertIssuedGateInvocation = spec => {
  assert(spec && typeof spec === 'object' && issuedGateInvocations.has(spec), 'GATE_INVOCATION_UNTRUSTED', 'Gate Executor invocation must come from the Gate Runner.');
  issuedGateInvocations.delete(spec);
};
export const assertIssuedGateSubmission = input => {
  assert(input && typeof input === 'object' && issuedGateSubmissions.has(input), 'GATE_SUBMISSION_UNTRUSTED', 'Gate Authority updates require a result issued by the Gate Runner.');
  issuedGateSubmissions.delete(input);
};
const fileDigest = path => new Promise((resolveDigest, reject) => {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  stream.on('data', chunk => hash.update(chunk));
  stream.on('error', reject);
  stream.on('end', () => resolveDigest(hash.digest('hex')));
});
const toolchainInputs = async (recipe, cwd) => {
  const name = recipe.command[0].split(/[\\/]/).at(-1).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  const args = recipe.command.slice(1);
  const paths = [];
  if (name === 'node' && !args.some(arg => ['-e', '--eval'].includes(arg))) {
    const script = args.find(arg => !arg.startsWith('-'));
    if (script) paths.push(script);
  }
  if (['powershell', 'pwsh'].includes(name)) {
    const index = args.findIndex(arg => arg.toLowerCase() === '-file');
    if (index >= 0 && args[index + 1]) paths.push(args[index + 1]);
  }
  if (['npm', 'pnpm', 'yarn'].includes(name)) paths.push('package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock');
  const digests = [];
  for (const path of paths) {
    const resolved = isAbsolute(path) ? path : resolve(cwd, path);
    try { digests.push({ path: resolved, digest: await fileDigest(resolved) }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return digests;
};

const validateRecipe = recipe => {
  assert(recipe?.id && Array.isArray(recipe.command) && recipe.command.length > 0, 'GATE_RECIPE_INVALID', 'Gate Recipe requires an id and non-empty command array.');
  assertExecutionClass(recipe.executionClass, EXECUTION_CLASSES.DETERMINISTIC_PROCESS, { code: 'GATE_EXECUTION_CLASS_INVALID', subject: `Gate Recipe ${recipe.id}` });
  return { scope: 'feature', required: true, ...structuredClone(recipe), command: recipe.command.map(String) };
};

const executableCandidates = (executable, cwd) => {
  if (isAbsolute(executable) || /[\\/]/.test(executable)) return [isAbsolute(executable) ? executable : resolve(cwd, executable)];
  const extensions = process.platform === 'win32' ? String(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  return String(process.env.PATH ?? '').split(delimiter).filter(Boolean).flatMap(directory => extensions.map(extension => resolve(directory, process.platform === 'win32' && !executable.toLowerCase().endsWith(extension.toLowerCase()) ? `${executable}${extension}` : executable)));
};

const executableAvailable = async (executable, cwd) => {
  for (const candidate of executableCandidates(executable, cwd)) {
    try { await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return candidate; }
    catch {}
  }
  return null;
};

const commandPrerequisiteIssues = async (recipe, cwd) => {
  const issues = [];
  const executableName = recipe.command[0].split(/[\\/]/).at(-1).toLowerCase().replace(/\.exe$/, '');
  const args = recipe.command.slice(1);
  const requireFile = async (candidate, code, label) => {
    const file = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
    try { await access(file, constants.R_OK); }
    catch { issues.push({ code, message: `Gate ${recipe.id} ${label} is unavailable: ${file}` }); }
  };
  if (['powershell', 'pwsh'].includes(executableName)) {
    const fileIndex = args.findIndex(argument => argument.toLowerCase() === '-file');
    if (fileIndex >= 0 && args[fileIndex + 1]) await requireFile(args[fileIndex + 1], 'GATE_SCRIPT_UNAVAILABLE', 'PowerShell script');
  }
  if (executableName === 'node' && !args.includes('-e') && !args.includes('--eval')) {
    const script = args.find(argument => !argument.startsWith('-'));
    if (script) await requireFile(script, 'GATE_SCRIPT_UNAVAILABLE', 'Node script');
  }
  if (['npm', 'pnpm', 'yarn'].includes(executableName)) {
    const first = args.find(argument => !argument.startsWith('-'));
    const script = first === 'run' ? args[args.indexOf(first) + 1] : first;
    if (script && !['exec', 'dlx', 'install', 'add'].includes(script)) {
      try {
        const packageJson = JSON.parse(await readFile(resolve(cwd, 'package.json'), 'utf8'));
        if (typeof packageJson.scripts?.[script] !== 'string') issues.push({ code: 'GATE_PACKAGE_SCRIPT_UNAVAILABLE', message: `Gate ${recipe.id} package script is unavailable: ${script}` });
      } catch {
        issues.push({ code: 'GATE_PACKAGE_MANIFEST_UNAVAILABLE', message: `Gate ${recipe.id} requires a readable package.json in ${cwd}.` });
      }
    }
  }
  return issues;
};

const sandboxPrerequisiteIssues = (recipe, pluginHost) => {
  const issues = [];
  if (recipe.sandboxMode === 'required') {
    let available = false;
    if (recipe.sandboxPluginId && pluginHost) {
      try { available = pluginHost.get(recipe.sandboxPluginId, 'os-sandbox').manifest !== undefined; } catch {}
    }
    if (!available) issues.push({ code: 'OS_SANDBOX_REQUIRED', message: `Gate ${recipe.id} requires an installed OS sandbox provider.` });
  }
  return issues;
};

export const inspectProjectGateCapabilities = async ({ project, workspaceRoot, scope = 'final', gateIds = [], onProgress = null, pluginHost = null } = {}) => {
  const recipes = (project?.gateRecipes ?? []).map(validateRecipe).filter(recipe => recipe.scope === scope && (!gateIds.length || gateIds.includes(recipe.id)));
  const issues = [];
  if (typeof onProgress !== 'function') issues.push({ code: 'PROCESS_PROGRESS_OBSERVER_REQUIRED', message: 'Project Gate execution requires a live progress observer.' });
  if (!recipes.length) issues.push({ code: 'GATE_RECIPE_NOT_FOUND', message: `Project ${project?.id ?? '<unknown>'} has no Gate Recipes for scope ${scope}.` });
  for (const missingId of gateIds.filter(id => !recipes.some(recipe => recipe.id === id))) issues.push({ code: 'GATE_RECIPE_NOT_FOUND', message: `Project ${project?.id ?? '<unknown>'} does not declare required Gate ${missingId} for scope ${scope}.` });
  const gates = [];
  for (const recipe of recipes) {
    const cwd = resolve(workspaceRoot, recipe.cwd ?? '.');
    const executable = recipe.executorPluginId ? null : await executableAvailable(recipe.command[0], cwd);
    const gateIssues = [];
    const relativeCwd = relative(resolve(workspaceRoot), cwd);
    if (relativeCwd.startsWith('..') || isAbsolute(relativeCwd)) gateIssues.push({ code: 'GATE_WORKING_DIRECTORY_OUTSIDE_WORKSPACE', message: `Gate ${recipe.id} working directory escapes the Project workspace: ${cwd}` });
    try { await access(cwd, constants.R_OK); }
    catch { gateIssues.push({ code: 'GATE_WORKING_DIRECTORY_UNAVAILABLE', message: `Gate ${recipe.id} working directory is unavailable: ${cwd}` }); }
    if (!recipe.executorPluginId && !executable) gateIssues.push({ code: 'GATE_EXECUTABLE_UNAVAILABLE', message: `Gate ${recipe.id} executable is unavailable: ${recipe.command[0]}` });
    if (recipe.executorPluginId) {
      try { assert(pluginHost?.get(recipe.executorPluginId, 'gate-executor')?.manifest, 'GATE_EXECUTOR_UNAVAILABLE', 'Gate Executor is not installed.'); }
      catch { gateIssues.push({ code: 'GATE_EXECUTOR_UNAVAILABLE', message: `Gate ${recipe.id} Executor is unavailable: ${recipe.executorPluginId}` }); }
    } else gateIssues.push(...await commandPrerequisiteIssues(recipe, cwd));
    gateIssues.push(...sandboxPrerequisiteIssues(recipe, pluginHost));
    issues.push(...gateIssues);
    gates.push({ id: recipe.id, ready: gateIssues.length === 0, command: [...recipe.command], cwd, executable, issues: gateIssues });
  }
  return { ready: issues.length === 0, observerReady: typeof onProgress === 'function', gates, issues };
};

export class ProjectGateRunner {
  constructor({ harness, id = newId, onProgress = null }) {
    this.harness = harness;
    this.id = id;
    this.onProgress = onProgress;
    this.cache = new GateCache({ root: harness.dataRoot, controlRoot: harness.controlRoot });
  }

  async preflight({ projectId, scope = 'final', gateIds = [], workspaceRoot = null } = {}) {
    const project = await this.harness.projectRegistry.get(projectId);
    return inspectProjectGateCapabilities({ project, workspaceRoot: workspaceRoot ?? project.workspace.root, scope, gateIds, onProgress: this.onProgress, pluginHost: this.harness.pluginHost });
  }

  async run({ projectId, runId, scope = 'final', featureId = null, forceFresh = false, gateIds = [] }) {
    assert(typeof this.onProgress === 'function', 'PROCESS_PROGRESS_OBSERVER_REQUIRED', 'Project Gate execution requires a live progress observer.');
    const project = await this.harness.projectRegistry.get(projectId);
    let state = await this.harness.authorityStore.read(projectId, runId);
    const currentPluginSetDigest = digestJson({ plugins: this.harness.pluginHost.snapshot().manifests, extensions: this.harness.extensionSet.installed });
    assert(currentPluginSetDigest === state.pluginSetDigest, 'GATE_PLUGIN_SET_DRIFT', 'Installed Gate plugins differ from the Run plugin composition.');
    const workspaceRoot = state.metadata?.workspace?.root ?? project.workspace.root;
    const recipes = (state.metadata?.gateRecipes ?? []).map(validateRecipe).filter(recipe => recipe.scope === scope && (!gateIds.length || gateIds.includes(recipe.id)));
    assert(recipes.length > 0, 'GATE_RECIPE_NOT_FOUND', `Project ${projectId} has no Gate Recipes for scope ${scope}.`);
    for (const gateId of gateIds) assert(recipes.some(recipe => recipe.id === gateId), 'GATE_RECIPE_NOT_FOUND', `Project ${projectId} does not declare Gate ${gateId} for scope ${scope}.`);
    assert(scope !== 'feature' || state.features.some(feature => feature.id === featureId && feature.state === 'completed'), 'GATE_FEATURE_INVALID', 'Feature Gate requires a completed Feature.');
    const host = new PluginHost({ allowedPermissions: ['gate.execute'] });
    host.register(manifest, createProcessGateExecutor({
      manifest,
      workspaceRoot,
      temporaryRoot: `${this.harness.dataRoot}/tmp/gates`,
      controlRoot: this.harness.controlRoot,
      resolveSandbox: ({ allowed }) => allowed.sandboxPluginId ? this.harness.pluginHost.get(allowed.sandboxPluginId, 'os-sandbox') : null,
      allowlist: recipes.map(recipe => ({ id: recipe.id, executable: recipe.command[0], args: recipe.command.slice(1), cwd: recipe.cwd, timeoutMs: recipe.timeoutMs, environment: recipe.environment, outputs: recipe.outputs, sandboxMode: recipe.sandboxMode, sandboxPluginId: recipe.sandboxPluginId })),
      onProgress: this.onProgress,
    }));
    const results = [];
    for (const recipe of recipes) {
      state = await this.harness.authorityStore.read(projectId, runId);
      const before = await captureWorkspace(workspaceRoot, { excluded: state.metadata?.workspace?.excluded ?? [] });
      assert(before.digest === state.sourceDigest, 'WORKSPACE_SOURCE_DRIFT', 'Workspace changed before Gate execution.', { authoritySourceDigest: state.sourceDigest, workspaceSourceDigest: before.digest });
      const spec = { id: recipe.id, commandId: recipe.id, args: [], recipe: structuredClone(recipe), projectId, runId, epoch: state.epoch, generation: state.generation, sourceDigest: state.sourceDigest, featureId };
      if (recipe.cwd !== undefined) spec.cwd = recipe.cwd;
      if (recipe.timeoutMs !== undefined) spec.timeoutMs = recipe.timeoutMs;
      const specDigest = digestJson({ recipe, featureId, command: recipe.command, cwd: recipe.cwd ?? '.', timeoutMs: recipe.timeoutMs ?? 300000 });
      const executorPlugin = recipe.executorPluginId ? this.harness.pluginHost.get(recipe.executorPluginId, 'gate-executor').manifest : manifest;
      const executable = recipe.executorPluginId ? null : await executableAvailable(recipe.command[0], resolve(workspaceRoot, recipe.cwd ?? '.'));
      assert(recipe.executorPluginId || executable, 'GATE_EXECUTABLE_UNAVAILABLE', `Gate ${recipe.id} executable is unavailable.`);
      const toolchainDigest = digestJson({ declared: recipe.toolchainDigest ?? null, executable, executableDigest: executable ? await fileDigest(executable) : null, inputs: recipe.executorPluginId ? [] : await toolchainInputs(recipe, resolve(workspaceRoot, recipe.cwd ?? '.')), executorPlugin });
      const cacheKey = { gateId: recipe.id, specDigest, sourceDigest: state.sourceDigest, artifactDigest: state.artifactDigest, policyDigest: state.policyDigest, toolchainDigest, environmentDigest: digestJson({ platform: process.platform, arch: process.arch, inherited: process.env }), pluginDigest: digestJson({ executorPlugin, pluginSetDigest: state.pluginSetDigest, harnessDigest: state.metadata?.lifecycleExecution?.harnessArtifactDigest ?? this.harness.releaseIdentity.artifactDigest }) };
      const cached = await this.cache.get(cacheKey, { forceFresh: forceFresh || recipe.forceFresh === true });
      let status;
      let evidenceRefs;
      let executorReceipt = null;
      let cacheOriginRef = null;
      let after = before;
      if (cached.hit) {
        cacheOriginRef = cached.value.result.evidenceRefs?.[0];
        const origin = await this.harness.evidenceStore.read(cacheOriginRef);
        const originBody = JSON.parse(origin.bytes.toString('utf8'));
        assert(origin.metadata.sourceDigest === state.sourceDigest && origin.metadata.gateSpecDigest === specDigest && origin.metadata.toolchainDigest === toolchainDigest && originBody.status === 'passed' && originBody.executorReceipt?.payload?.status === 'passed', 'GATE_CACHE_EVIDENCE_INVALID', 'Cached Gate Evidence is not reusable.');
        executorReceipt = originBody.executorReceipt;
        after = await captureWorkspace(workspaceRoot, { excluded: state.metadata?.workspace?.excluded ?? [] });
        status = after.digest === before.digest ? 'passed' : 'failed';
        this.onProgress({ gateId: recipe.id, phase: 'cache-hit', status });
      } else {
        if (recipe.executorPluginId) issuedGateInvocations.add(spec);
        executorReceipt = recipe.executorPluginId ? await this.harness.invokeGateExecutor(recipe.executorPluginId, spec, { onProgress: this.onProgress }) : await host.invoke(manifest.id, 'execute', spec);
        assert(executorReceipt.type === 'receipt' && executorReceipt.pluginId === executorPlugin.id && executorReceipt.pluginVersion === executorPlugin.version && executorReceipt.payload?.operation === 'gate' && executorReceipt.payload?.gateId === recipe.id && executorReceipt.payload?.specDigest === digestJson(spec) && ['passed', 'failed', 'environment-failed', 'budget-exceeded'].includes(executorReceipt.payload?.status), 'GATE_EXECUTOR_RECEIPT_INVALID', 'Gate Executor returned a mismatched Receipt.');
        if (recipe.sandboxMode === 'required') assert(executorReceipt.payload.sandboxReceipt?.applied === true, 'GATE_SANDBOX_RECEIPT_REQUIRED', 'Required Gate sandbox was not applied.');
        after = await captureWorkspace(workspaceRoot, { excluded: state.metadata?.workspace?.excluded ?? [] });
        status = after.digest === before.digest ? executorReceipt.payload.status : 'failed';
      }
      assert(after.digest === before.digest || status === 'failed', 'GATE_SOURCE_DRIFT', 'Gate changed its source workspace.');
      const evidence = await this.harness.evidenceStore.put({ recipe, spec, specDigest, status, executorPlugin: { id: executorPlugin.id, version: executorPlugin.version }, executorReceipt, sourceBefore: before.digest, sourceAfter: after.digest, sourceDrift: after.digest !== before.digest, cacheHit: cached.hit, cacheOriginRef }, { mediaType: 'application/json', projectId, ...(state.metadata?.workspaceRef ? { workspaceRef: state.metadata.workspaceRef } : {}), runId, epoch: state.epoch, generation: state.generation, sourceDigest: state.sourceDigest, artifactDigest: state.artifactDigest, policyDigest: state.policyDigest, pluginSetDigest: state.pluginSetDigest, toolchainDigest, gateSpecDigest: specDigest, labels: ['gate-result', `gate:${recipe.id}`] });
      evidenceRefs = [evidence.ref];
      if (status === 'passed' && !cached.hit) await this.cache.put(cacheKey, { status, evidenceRefs });
      state = await this.harness.authorityStore.read(projectId, runId);
      const submission = { id: recipe.id, scope, featureId, specDigest, sourceDigest: state.sourceDigest, toolchainDigest, status, evidenceRefs, forcedFresh: !cached.hit, cacheHit: cached.hit };
      issuedGateSubmissions.add(submission);
      const recorded = await this.harness.recordVerifiedGate(projectId, runId, submission, { expectedRevision: state.revision, commandId: this.id('gate-record') });
      results.push({ id: recipe.id, status, cacheHit: cached.hit, evidenceRefs, executorReceipt, revision: recorded.state.revision });
    }
    return { projectId, runId, scope, forceFresh, results, state: await this.harness.authorityStore.read(projectId, runId) };
  }
}

export const runPendingFeatureGates = async ({ harness, projectId, runId, onProgress }) => {
  const runner = new ProjectGateRunner({ harness, onProgress });
  let state = await harness.authorityStore.read(projectId, runId);
  const recipes = new Set((state.metadata?.gateRecipes ?? []).filter(recipe => recipe.scope === 'feature').map(recipe => recipe.id));
  const failures = [];
  for (const feature of state.features.filter(item => item.state === 'completed')) {
    const ids = feature.gatePlan.filter(id => recipes.has(id) && !state.gates.some(gate => gate.id === id && gate.scope === 'feature' && gate.featureId === feature.id && gate.status === 'passed' && gate.sourceDigest === state.sourceDigest));
    if (!ids.length) continue;
    const result = await runner.run({ projectId, runId, scope: 'feature', featureId: feature.id, gateIds: ids, forceFresh: true });
    state = result.state;
    if (!result.results.every(gate => gate.status === 'passed')) failures.push({ featureId: feature.id, results: result.results });
  }
  return { ok: failures.length === 0, state, failures, results: failures.flatMap(item => item.results), featureId: failures[0]?.featureId ?? null };
};
