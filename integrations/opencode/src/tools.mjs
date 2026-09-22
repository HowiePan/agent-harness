import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assert } from '../../../src/common/errors.mjs';
import { WorkspaceRegistry, workspaceDecisionContext } from '../../../src/platform/workspace/workspace-registry.mjs';
import { defaultDataRoot } from '../../../src/application/harness.mjs';
import { harnessControlRoot } from '../../../src/common/write-boundary.mjs';

/**
 * Native tool definitions exposable to OpenCode model context.
 */
export const createOpenCodeTools = ({ harness = null, getHarness = null } = {}) => {
  const resolveHarness = async () => {
    const instance = harness ?? (typeof getHarness === 'function' ? await getHarness() : null);
    assert(instance, 'HARNESS_INSTANCE_UNAVAILABLE', 'Agent Harness instance is not available.');
    return instance;
  };

  return {
    harness_init: {
      description: 'Initialize and register an Agent Harness workspace from a local harness.json configuration file.',
      parameters: {
        type: 'object',
        properties: {
          actor: { type: 'string', description: 'The approving actor name (e.g. howie).' },
          file: { type: 'string', description: 'Path to workspace configuration file, defaults to harness.json.' },
        },
      },
      execute: async ({ actor = 'howie', file = 'harness.json' } = {}) => {
        const cleanActor = String(actor ?? '').trim() || 'howie';
        const cleanFile = String(file ?? '').trim() || 'harness.json';
        const controlRoot = harnessControlRoot();
        const dataRoot = defaultDataRoot(controlRoot);
        const resolvedPath = resolve(process.cwd(), cleanFile);
        const content = await readFile(resolvedPath, 'utf8');
        const input = JSON.parse(content);
        const registry = new WorkspaceRegistry({ root: dataRoot, controlRoot });
        const current = await registry.get(input.workspaceId, { required: false });
        const expectedRevision = current?.revision ?? 0;
        const commandId = `init-${Date.now()}`;
        const authorityDecision = {
          actor: cleanActor,
          decision: 'approved',
          action: 'workspace-register',
          expiresAt: '2099-01-01T00:00:00.000Z',
          context: workspaceDecisionContext({ current, input, expectedRevision }),
        };
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
        const project = await h.projectRegistry.get(projectId);
        const activeRun = runId ?? (await h.authorityStore.activeRun(projectId));
        if (!activeRun) {
          return { status: 'idle', projectId, message: 'No active Run found for this project.' };
        }
        const state = await h.authorityStore.read(projectId, activeRun);
        const profile = h.profileRegistry.get(state.profile.id);
        const projection = profile.project(state);
        return {
          status: state.status,
          projectId,
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
        const project = await h.projectRegistry.get(projectId);
        const activeRun = await h.authorityStore.activeRun(projectId);
        assert(activeRun, 'ACTIVE_RUN_REQUIRED', `Project ${projectId} has no active Run for Gate execution.`);
        const runner = h.createProjectGateRunner ? h.createProjectGateRunner({ onProgress: () => {} }) : null;
        assert(runner, 'GATE_RUNNER_UNAVAILABLE', 'ProjectGateRunner is not configured on Harness.');
        const result = await runner.run({
          projectId,
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
