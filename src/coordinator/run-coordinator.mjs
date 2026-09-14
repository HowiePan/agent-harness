import { newId } from '../canonical.mjs';
import { assert } from '../errors.mjs';

const parseLastJsonObject = text => {
  const lines = String(text ?? '').split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {}
  }
  return null;
};

export const businessResultFromRuntime = payload => {
  const candidate = payload?.result && typeof payload.result === 'object' ? payload.result : parseLastJsonObject(payload?.stdout);
  if (candidate && ['completed', 'blocked', 'failed'].includes(candidate.status) && candidate.summary) return candidate;
  const startupFailure = payload?.startupError ?? payload?.processError ?? null;
  const summary = startupFailure?.message ?? payload?.resultError?.message ?? `Runtime ended without a valid business result${payload?.exitCode === undefined ? '' : ` (exit ${payload.exitCode})`}.`;
  const failureClass = startupFailure ? 'runtime-startup' : 'runtime';
  return { status: 'failed', summary, failureClass, blocker: { kind: failureClass, summary }, changedFiles: [] };
};

export class RunCoordinator {
  constructor({ harness, id = newId }) {
    this.harness = harness;
    this.id = id;
  }

  async tick({ projectId, runId, runtimePluginId, maxConcurrency = 1 }) {
    const project = await this.harness.projectRegistry.get(projectId);
    const selectedRuntime = runtimePluginId ?? project.policy?.defaultRuntimePlugin;
    assert(selectedRuntime, 'DEFAULT_RUNTIME_REQUIRED', `Project ${projectId} requires a default Runtime or an explicit runtimePluginId.`);
    assert((project.policy?.runtimePlugins ?? []).includes(selectedRuntime), 'PROJECT_RUNTIME_DENIED', `Runtime ${selectedRuntime} is not allowed by Project ${projectId}.`);
    const runtime = this.harness.pluginHost.get(selectedRuntime, 'agent-runtime');
    const configuredLimit = Math.max(1, Number(project.policy?.maxConcurrency ?? maxConcurrency));
    const requestedLimit = Math.max(1, Math.min(Number(maxConcurrency), configuredLimit));
    const physicalLimit = runtime.manifest.capabilities.includes('workspace-shared') ? 1 : requestedLimit;
    let state = await this.harness.authorityStore.read(projectId, runId);
    const orphaned = state.leases.filter(lease => lease.status === 'active');
    if (orphaned.length) return { status: 'attention-required', reason: 'active-leases-require-original-runtime-or-resume', leaseIds: orphaned.map(lease => lease.leaseId), state };
    let dispatches = state.dispatches.filter(dispatch => dispatch.status === 'requested');
    if (!dispatches.length) {
      const scheduled = await this.harness.dispatch(projectId, runId, { maxConcurrency: physicalLimit, runtimePluginId: selectedRuntime }, { expectedRevision: state.revision, commandId: this.id('coordinator-schedule') });
      state = scheduled.state;
      dispatches = scheduled.result.dispatches;
    }
    if (!dispatches.length) return { status: 'idle', reason: state.status, state, physicalLimit };
    dispatches = dispatches.slice(0, physicalLimit);
    const spawned = [];
    const cleanedAgents = new Set();
    const committed = [];
    let primaryError = null;
    try {
      for (const dispatch of dispatches) {
        const result = await this.harness.spawnDispatch(projectId, runId, dispatch.dispatchId, selectedRuntime, `coordinator-bind-${dispatch.dispatchId}`);
        spawned.push({ dispatch, lease: result.lease });
        state = result.state;
      }
      const waits = await Promise.all(spawned.map(async item => ({ item, receipt: await this.harness.pluginHost.invoke(selectedRuntime, 'wait', { agentId: item.lease.agentId }) })));
      for (const { item, receipt } of waits) {
        let result = businessResultFromRuntime(receipt.payload);
        if (typeof runtime.instance.integrate === 'function' && result.status === 'completed') await this.harness.pluginHost.invoke(selectedRuntime, 'integrate', { agentId: item.lease.agentId });
        else if (typeof runtime.instance.discard === 'function') { await this.harness.pluginHost.invoke(selectedRuntime, 'discard', { agentId: item.lease.agentId }); result = { ...result, changedFiles: [] }; }
        const cleanupReceipt = typeof runtime.instance.cleanup === 'function' ? await this.harness.pluginHost.invoke(selectedRuntime, 'cleanup', { agentId: item.lease.agentId }) : null;
        if (cleanupReceipt) cleanedAgents.add(item.lease.agentId);
        const output = await this.harness.recordResult(projectId, runId, item.dispatch.dispatchId, result, { commandId: `coordinator-submit-${item.dispatch.dispatchId}`, evidenceMetadata: { labels: ['agent-result', `runtime:${selectedRuntime}`] }, runtimeEvidence: { wait: receipt, cleanup: cleanupReceipt } });
        committed.push({ dispatchId: item.dispatch.dispatchId, featureId: item.dispatch.featureId, submissionId: output.result.submission.submissionId, status: output.result.featureState, runtimeReceipt: receipt, cleanupReceipt });
        state = output.state;
      }
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (typeof runtime.instance.cleanup === 'function') {
        const cleanupResults = await Promise.allSettled(spawned.filter(item => !cleanedAgents.has(item.lease.agentId)).map(item => this.harness.pluginHost.invoke(selectedRuntime, 'cleanup', { agentId: item.lease.agentId })));
        const cleanupFailure = cleanupResults.find(result => result.status === 'rejected');
        if (!primaryError && cleanupFailure) throw cleanupFailure.reason;
      }
    }
    return { status: 'progressed', runtimePluginId: selectedRuntime, physicalLimit, committed, state };
  }

  async run({ projectId, runId, runtimePluginId, maxConcurrency = 1, maxRounds = 100 }) {
    const rounds = [];
    for (let round = 1; round <= maxRounds; round += 1) {
      const result = await this.tick({ projectId, runId, runtimePluginId, maxConcurrency });
      rounds.push({ round, status: result.status, reason: result.reason ?? null, committed: result.committed?.map(item => ({ featureId: item.featureId, status: item.status })) ?? [] });
      if (result.status !== 'progressed') return { status: result.status, reason: result.reason, rounds, state: result.state };
    }
    const state = await this.harness.authorityStore.read(projectId, runId);
    return { status: 'attention-required', reason: 'coordinator-round-limit', rounds, state };
  }
}
