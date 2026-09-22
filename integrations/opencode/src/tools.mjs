import { assert } from '../../../src/common/errors.mjs';

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
