import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assert } from '../../../src/common/errors.mjs';
import { WorkspaceRegistry } from '../../../src/platform/workspace/workspace-registry.mjs';
import { defaultDataRoot } from '../../../src/application/harness.mjs';
import { harnessControlRoot } from '../../../src/common/write-boundary.mjs';
import { applyProjectInitializationPlan, createProjectInitializationPlan, loadProjectHarnessConfig } from '../../../src/application/project-initialization.mjs';
import { loadReleaseIdentity } from '../../../src/application/release-identity.mjs';
import { newId } from '../../../src/common/canonical.mjs';

/**
 * Native tool definitions exposable to OpenCode model context.
 */
export const createOpenCodeTools = ({ harness = null, getHarness = null } = {}) => {
  const resolveHarness = async () => {
    let instance = harness ?? (typeof getHarness === 'function' ? await getHarness() : null);
    if (!instance) {
      const { createHarness, defaultDataRoot } = await import('../../../src/application/harness.mjs');
      const { harnessControlRoot } = await import('../../../src/common/write-boundary.mjs');
      const { ExtensionRegistry } = await import('../../../src/platform/extensions/registry.mjs');
      const controlRoot = harnessControlRoot();
      const dataRoot = defaultDataRoot(controlRoot);
      const extReg = new ExtensionRegistry({ dataRoot, controlRoot });
      const extensions = await extReg.loadInstalled().catch(() => []);
      let workspaceId = null;
      try {
        const localHarness = JSON.parse(await readFile(resolve(process.cwd(), 'harness.json'), 'utf8'));
        workspaceId = localHarness.workspaceId ?? null;
      } catch {}
      instance = await createHarness({
        controlRoot,
        dataRoot,
        workspaceId,
        extensions,
        strictProjectIdentity: false,
      });
    }
    assert(instance, 'HARNESS_INSTANCE_UNAVAILABLE', 'Agent Harness instance is not available.');
    return instance;
  };

  const resolveTargetProjectId = async (h, projectId) => {
    if (!projectId) return projectId;
    const { parseWorkspaceProjectionId, workspaceProjectionId } = await import('../../../src/platform/workspace/workspace-registry.mjs');
    if (parseWorkspaceProjectionId(projectId)) return projectId;
    if (h.workspaceRegistry) {
      const workspaces = await h.workspaceRegistry.list().catch(() => []);
      for (const ws of workspaces) {
        const memberProject = ws.projects?.find(p => p.id === projectId);
        if (memberProject) {
          const targetId = memberProject.executionTargetIds?.[0] ?? ws.workflows?.[0]?.executionTargetId;
          if (targetId) return workspaceProjectionId(ws.workspaceId, targetId);
        }
      }
    }
    return projectId;
  };

  return {
    harness_init: {
      description: 'Initialize and register an Agent Harness project or Workspace from its project-owned harness.json configuration.',
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Path to workspace configuration file, defaults to harness.json.' },
          decisionFile: { type: 'string', description: 'Path to an externally issued workspace-register Authority Decision.' },
          projectRoot: { type: 'string', description: 'Project root used to resolve relative paths; defaults to the current directory.' },
        },
        required: ['decisionFile'],
      },
      execute: async ({ file = 'harness.json', decisionFile, projectRoot = process.cwd() } = {}) => {
        const cleanFile = String(file ?? '').trim() || 'harness.json';
        const cleanDecisionFile = String(decisionFile ?? '').trim();
        assert(cleanDecisionFile, 'WORKSPACE_DECISION_FILE_REQUIRED', 'Workspace initialization requires an externally issued Authority Decision file.');
        const controlRoot = harnessControlRoot();
        const dataRoot = defaultDataRoot(controlRoot);
        const resolvedPath = resolve(process.cwd(), cleanFile);
        const content = await readFile(resolvedPath, 'utf8');
        const input = JSON.parse(content);
        if (input.kind === 'agent-harness-project') {
          const releaseIdentity = await loadReleaseIdentity();
          const plan = await createProjectInitializationPlan(resolvedPath, { projectRoot, controlRoot, dataRoot, releaseIdentity, mode: 'installed' });
          const authorityDecision = JSON.parse(await readFile(resolve(process.cwd(), cleanDecisionFile), 'utf8'));
          const output = await applyProjectInitializationPlan(plan, { controlRoot, dataRoot, releaseIdentity, commandId: newId('opencode-init'), authorityDecision });
          const loaded = await loadProjectHarnessConfig(resolvedPath, { projectRoot });
          return {
            ok: true,
            kind: input.kind,
            projectId: loaded.request.binding.projectId,
            alias: loaded.config.binding.alias ?? loaded.request.binding.projectId,
            receipt: output.receipt,
            message: `Project "${loaded.request.binding.projectId}" successfully initialized from its project-owned harness.json.`,
          };
        }
        const registry = new WorkspaceRegistry({ root: dataRoot, controlRoot });
        const current = await registry.get(input.workspaceId, { required: false, validate: false });
        const expectedRevision = current?.revision ?? 0;
        const commandId = `init-${Date.now()}`;
        const authorityDecision = JSON.parse(await readFile(resolve(process.cwd(), cleanDecisionFile), 'utf8'));
        const workspace = await registry.register(input, { expectedRevision, commandId, authorityDecision });
        return {
          ok: true,
          workspaceId: workspace.workspaceId,
          alias: workspace.alias,
          revision: workspace.revision,
          projects: workspace.projects.map(p => p.id),
          sources: workspace.sources.map(s => ({ id: s.sourceId, type: s.type, root: s.root })),
          message: `Workspace "${workspace.workspaceId}" (alias: "${workspace.alias}") successfully registered at revision ${workspace.revision}.`,
        };
      },
    },

    harness_status: {
      description: 'Query status, active Run, and finding ledger for a project in Agent Harness.',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'The registered project identifier.' },
          runId: { type: 'string', description: 'Optional specific run identifier.' },
        },
        required: ['projectId'],
      },
      execute: async ({ projectId, runId = null }) => {
        const h = await resolveHarness();
        const effectiveProjectId = await resolveTargetProjectId(h, projectId);
        const runs = await h.authorityStore.list(effectiveProjectId);
        const activeRun = runId ?? (typeof h.authorityStore.activeRun === 'function' ? await h.authorityStore.activeRun(effectiveProjectId) : runs.find(r => r.status !== 'closed' && r.status !== 'cancelled')?.runId ?? null);
        if (!activeRun) {
          return { status: 'idle', projectId: effectiveProjectId, message: 'No active Run found for this project.' };
        }
        const state = await h.authorityStore.read(effectiveProjectId, activeRun);
        const profile = h.profileRegistry.get(state.profile.id);
        const projection = profile?.project ? profile.project(state) : null;
        return {
          status: state.status,
          projectId: effectiveProjectId,
          runId: state.runId,
          epoch: state.epoch,
          generation: state.generation,
          projection,
          openFindings: state.findings.filter(f => f.status !== 'resolved'),
        };
      },
    },

    harness_gate: {
      description: 'Execute deterministic process gates (quality tests, linters) on the project workspace.',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'The registered project identifier.' },
          scope: { type: 'string', enum: ['feature', 'final'], default: 'final' },
          gateIds: { type: 'array', items: { type: 'string' }, description: 'Optional subset of gate IDs to run.' },
        },
        required: ['projectId'],
      },
      execute: async ({ projectId, scope = 'final', gateIds = [] }) => {
        const h = await resolveHarness();
        const effectiveProjectId = await resolveTargetProjectId(h, projectId);
        const project = await h.projectRegistry.get(effectiveProjectId);
        const recipes = (project.gateRecipes ?? []).filter(r => r.scope === scope);
        if (!recipes.length) {
          return {
            ok: true,
            results: [],
            message: `No gate recipes configured for project "${effectiveProjectId}" under scope "${scope}".`,
          };
        }
        const runs = await h.authorityStore.list(effectiveProjectId);
        const activeRun = typeof h.authorityStore.activeRun === 'function' ? await h.authorityStore.activeRun(effectiveProjectId) : runs.find(r => r.status !== 'closed' && r.status !== 'cancelled')?.runId ?? runs[0]?.runId ?? null;
        assert(activeRun, 'ACTIVE_RUN_REQUIRED', `Project ${effectiveProjectId} has no active Run for Gate execution.`);
        const { ProjectGateRunner } = await import('../../../src/platform/workflow/gates/project-gate-runner.mjs');
        const runner = new ProjectGateRunner({ harness: h, onProgress: () => {} });
        const result = await runner.run({
          projectId: effectiveProjectId,
          runId: activeRun,
          scope,
          gateIds,
        });
        return {
          ok: result.results.every(g => g.status === 'passed'),
          results: result.results.map(g => ({ id: g.id, status: g.status })),
        };
      },
    },
  };
};
