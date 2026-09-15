import { digestJson, newId } from '../canonical.mjs';
import { assert } from '../errors.mjs';
import { GateCache } from '../kernel/gate-cache.mjs';
import { PluginHost } from '../plugins/host.mjs';
import { createProcessGateExecutor } from '../plugins/gate/process-gate.mjs';
import { captureWorkspace } from '../workspace-snapshot.mjs';
import { DEFAULT_PROCESS_OUTPUTS } from '../plugins/execution/managed-output.mjs';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, relative, resolve } from 'node:path';

const manifest = Object.freeze({ id: 'project-process-gates', kind: 'gate-executor', version: '1.0.0', capabilities: ['process', 'success-cache', 'fresh-final', 'managed-outputs'], permissions: ['gate.execute'], execution: { outputs: DEFAULT_PROCESS_OUTPUTS, sandbox: { mode: 'optional' } } });

const validateRecipe = recipe => {
  assert(recipe?.id && Array.isArray(recipe.command) && recipe.command.length > 0, 'GATE_RECIPE_INVALID', 'Gate Recipe requires an id and non-empty command array.');
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
  if (recipe.sandboxMode === 'required') issues.push({ code: 'OS_SANDBOX_REQUIRED', message: `Gate ${recipe.id} requires an OS sandbox provider, but the Project Gate Runner has no bound provider.` });
  return issues;
};

export const inspectProjectGateCapabilities = async ({ project, workspaceRoot, scope = 'final', gateIds = [], onProgress = null } = {}) => {
  const recipes = (project?.gateRecipes ?? []).map(validateRecipe).filter(recipe => recipe.scope === scope && (!gateIds.length || gateIds.includes(recipe.id)));
  const issues = [];
  if (typeof onProgress !== 'function') issues.push({ code: 'PROCESS_PROGRESS_OBSERVER_REQUIRED', message: 'Project Gate execution requires a live progress observer.' });
  if (!recipes.length) issues.push({ code: 'GATE_RECIPE_NOT_FOUND', message: `Project ${project?.id ?? '<unknown>'} has no Gate Recipes for scope ${scope}.` });
  for (const missingId of gateIds.filter(id => !recipes.some(recipe => recipe.id === id))) issues.push({ code: 'GATE_RECIPE_NOT_FOUND', message: `Project ${project?.id ?? '<unknown>'} does not declare required Gate ${missingId} for scope ${scope}.` });
  const gates = [];
  for (const recipe of recipes) {
    const cwd = resolve(workspaceRoot, recipe.cwd ?? '.');
    const executable = await executableAvailable(recipe.command[0], cwd);
    const gateIssues = [];
    const relativeCwd = relative(resolve(workspaceRoot), cwd);
    if (relativeCwd.startsWith('..') || isAbsolute(relativeCwd)) gateIssues.push({ code: 'GATE_WORKING_DIRECTORY_OUTSIDE_WORKSPACE', message: `Gate ${recipe.id} working directory escapes the Project workspace: ${cwd}` });
    try { await access(cwd, constants.R_OK); }
    catch { gateIssues.push({ code: 'GATE_WORKING_DIRECTORY_UNAVAILABLE', message: `Gate ${recipe.id} working directory is unavailable: ${cwd}` }); }
    if (!executable) gateIssues.push({ code: 'GATE_EXECUTABLE_UNAVAILABLE', message: `Gate ${recipe.id} executable is unavailable: ${recipe.command[0]}` });
    gateIssues.push(...await commandPrerequisiteIssues(recipe, cwd));
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
    return inspectProjectGateCapabilities({ project, workspaceRoot: workspaceRoot ?? project.workspace.root, scope, gateIds, onProgress: this.onProgress });
  }

  async run({ projectId, runId, scope = 'final', forceFresh = false, gateIds = [] }) {
    assert(typeof this.onProgress === 'function', 'PROCESS_PROGRESS_OBSERVER_REQUIRED', 'Project Gate execution requires a live progress observer.');
    const project = await this.harness.projectRegistry.get(projectId);
    let state = await this.harness.authorityStore.read(projectId, runId);
    const workspaceRoot = state.metadata?.workspace?.root ?? project.workspace.root;
    const recipes = (project.gateRecipes ?? []).map(validateRecipe).filter(recipe => recipe.scope === scope && (!gateIds.length || gateIds.includes(recipe.id)));
    assert(recipes.length > 0, 'GATE_RECIPE_NOT_FOUND', `Project ${projectId} has no Gate Recipes for scope ${scope}.`);
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
      const before = await captureWorkspace(workspaceRoot, { excluded: project.workspace.excluded ?? [] });
      assert(before.digest === state.sourceDigest, 'WORKSPACE_SOURCE_DRIFT', 'Workspace changed before Gate execution.', { authoritySourceDigest: state.sourceDigest, workspaceSourceDigest: before.digest });
      const spec = { id: recipe.id, commandId: recipe.id, args: [] };
      if (recipe.cwd !== undefined) spec.cwd = recipe.cwd;
      if (recipe.timeoutMs !== undefined) spec.timeoutMs = recipe.timeoutMs;
      const specDigest = digestJson({ recipe, spec });
      const toolchainDigest = recipe.toolchainDigest ?? digestJson({ executable: recipe.command[0], arguments: recipe.command.slice(1), node: process.version });
      const cacheKey = { gateId: recipe.id, specDigest, sourceDigest: state.sourceDigest, toolchainDigest, environmentDigest: digestJson({ platform: process.platform, arch: process.arch }), pluginDigest: digestJson(manifest) };
      const cached = await this.cache.get(cacheKey, { forceFresh: forceFresh || recipe.forceFresh === true });
      let status;
      let evidenceRefs;
      let executorReceipt = null;
      if (cached.hit) {
        this.onProgress({ gateId: recipe.id, phase: 'cache-hit', status: 'passed' });
        status = 'passed';
        evidenceRefs = cached.value.result.evidenceRefs;
      } else {
        executorReceipt = await host.invoke(manifest.id, 'execute', spec);
        const after = await captureWorkspace(workspaceRoot, { excluded: project.workspace.excluded ?? [] });
        status = after.digest === before.digest ? executorReceipt.payload.status : 'failed';
        const evidence = await this.harness.evidenceStore.put({ recipe, executorReceipt, sourceBefore: before.digest, sourceAfter: after.digest, sourceDrift: after.digest !== before.digest }, { mediaType: 'application/json', projectId, runId, epoch: state.epoch, generation: state.generation, sourceDigest: state.sourceDigest, artifactDigest: state.artifactDigest, policyDigest: state.policyDigest, pluginSetDigest: state.pluginSetDigest, toolchainDigest, gateSpecDigest: specDigest, labels: ['gate-result', `gate:${recipe.id}`] });
        evidenceRefs = [evidence.ref];
        if (status === 'passed') await this.cache.put(cacheKey, { status, evidenceRefs });
      }
      state = await this.harness.authorityStore.read(projectId, runId);
      const recorded = await this.harness.kernel.recordGate(projectId, runId, { id: recipe.id, scope, specDigest, sourceDigest: state.sourceDigest, toolchainDigest, status, evidenceRefs, forcedFresh: forceFresh || recipe.forceFresh === true, cacheHit: cached.hit }, { expectedRevision: state.revision, commandId: this.id('gate-record') });
      results.push({ id: recipe.id, status, cacheHit: cached.hit, evidenceRefs, executorReceipt, revision: recorded.state.revision });
    }
    return { projectId, runId, scope, forceFresh, results, state: await this.harness.authorityStore.read(projectId, runId) };
  }
}
