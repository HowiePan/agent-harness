import { digestJson, newId } from '../canonical.mjs';
import { assert } from '../errors.mjs';
import { GateCache } from '../kernel/gate-cache.mjs';
import { PluginHost } from '../plugins/host.mjs';
import { createProcessGateExecutor } from '../plugins/gate/process-gate.mjs';
import { captureWorkspace } from '../workspace-snapshot.mjs';
import { DEFAULT_PROCESS_OUTPUTS } from '../plugins/execution/managed-output.mjs';

const manifest = Object.freeze({ id: 'project-process-gates', kind: 'gate-executor', version: '1.0.0', capabilities: ['process', 'success-cache', 'fresh-final', 'managed-outputs'], permissions: ['gate.execute'], execution: { outputs: DEFAULT_PROCESS_OUTPUTS, sandbox: { mode: 'optional' } } });

const validateRecipe = recipe => {
  assert(recipe?.id && Array.isArray(recipe.command) && recipe.command.length > 0, 'GATE_RECIPE_INVALID', 'Gate Recipe requires an id and non-empty command array.');
  return { scope: 'feature', required: true, ...structuredClone(recipe), command: recipe.command.map(String) };
};

export class ProjectGateRunner {
  constructor({ harness, id = newId }) {
    this.harness = harness;
    this.id = id;
    this.cache = new GateCache({ root: harness.dataRoot, controlRoot: harness.controlRoot });
  }

  async run({ projectId, runId, scope = 'final', forceFresh = false, gateIds = [] }) {
    const project = await this.harness.projectRegistry.get(projectId);
    const recipes = (project.gateRecipes ?? []).map(validateRecipe).filter(recipe => recipe.scope === scope && (!gateIds.length || gateIds.includes(recipe.id)));
    assert(recipes.length > 0, 'GATE_RECIPE_NOT_FOUND', `Project ${projectId} has no Gate Recipes for scope ${scope}.`);
    const host = new PluginHost({ allowedPermissions: ['gate.execute'] });
    host.register(manifest, createProcessGateExecutor({
      manifest,
      workspaceRoot: project.workspace.root,
      temporaryRoot: `${this.harness.dataRoot}/tmp/gates`,
      controlRoot: this.harness.controlRoot,
      resolveSandbox: ({ allowed }) => allowed.sandboxPluginId ? this.harness.pluginHost.get(allowed.sandboxPluginId, 'os-sandbox') : null,
      allowlist: recipes.map(recipe => ({ id: recipe.id, executable: recipe.command[0], args: recipe.command.slice(1), cwd: recipe.cwd, timeoutMs: recipe.timeoutMs, environment: recipe.environment, outputs: recipe.outputs, sandboxMode: recipe.sandboxMode, sandboxPluginId: recipe.sandboxPluginId })),
    }));
    const results = [];
    for (const recipe of recipes) {
      let state = await this.harness.authorityStore.read(projectId, runId);
      const before = await captureWorkspace(project.workspace.root, { excluded: project.workspace.excluded ?? [] });
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
        status = 'passed';
        evidenceRefs = cached.value.result.evidenceRefs;
      } else {
        executorReceipt = await host.invoke(manifest.id, 'execute', spec);
        const after = await captureWorkspace(project.workspace.root, { excluded: project.workspace.excluded ?? [] });
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
