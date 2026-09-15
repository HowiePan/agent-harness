import { newId } from '../canonical.mjs';
import { assert } from '../errors.mjs';
import { AUTO_CONCURRENCY, AUTO_CONCURRENCY_LIMIT, resolveConcurrencyLimit } from '../concurrency.mjs';
import { assertAgentRuntimeCompatible } from '../plugins/runtime/execution-policy.mjs';

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
  const runtimeFailure = payload?.providerError ?? payload?.startupError ?? payload?.processError ?? null;
  const summary = runtimeFailure?.message ?? payload?.resultError?.message ?? `Runtime ended without a valid business result${payload?.exitCode === undefined ? '' : ` (exit ${payload.exitCode})`}.`;
  const failureClass = runtimeFailure?.failureClass ?? (payload?.startupError || payload?.processError ? 'runtime-startup' : 'runtime');
  const blocker = { kind: failureClass, summary, ...(runtimeFailure?.code ? { code: runtimeFailure.code } : {}) };
  return { status: 'failed', summary, failureClass, blocker, changedFiles: [] };
};

export class RunCoordinator {
  constructor({ harness, id = newId }) {
    this.harness = harness;
    this.id = id;
  }

  async tick({ projectId, runId, runtimePluginId, maxConcurrency } = {}) {
    const project = await this.harness.projectRegistry.get(projectId);
    const selectedRuntime = runtimePluginId ?? project.policy?.defaultRuntimePlugin;
    assert(selectedRuntime, 'DEFAULT_RUNTIME_REQUIRED', `Project ${projectId} requires a default Runtime or an explicit runtimePluginId.`);
    assert((project.policy?.runtimePlugins ?? []).includes(selectedRuntime), 'PROJECT_RUNTIME_DENIED', `Runtime ${selectedRuntime} is not allowed by Project ${projectId}.`);
    const runtimeManifest = this.harness.getRuntimeManifest(selectedRuntime);
    const runtimePolicy = assertAgentRuntimeCompatible({ project, manifest: runtimeManifest });
    const configuredLimit = resolveConcurrencyLimit(project.policy?.maxConcurrency, project.policy?.maxConcurrency === AUTO_CONCURRENCY ? AUTO_CONCURRENCY_LIMIT : 1);
    const requestedLimit = resolveConcurrencyLimit(maxConcurrency, configuredLimit);
    const physicalLimit = runtimeManifest.capabilities.includes('workspace-shared') ? 1 : requestedLimit;
    let state = await this.harness.authorityStore.read(projectId, runId);
    if (runtimePolicy.hostOrchestrated) return { status: 'attention-required', reason: 'user-visible-runtime-requires-host-orchestration', runtimePluginId: selectedRuntime, state, physicalLimit };
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
      const waits = await Promise.all(spawned.map(async item => ({ item, receipt: await this.harness.invokeBoundRuntime(projectId, runId, item.lease.dispatchId, 'wait') })));
      for (const { item, receipt } of waits) {
        let result = businessResultFromRuntime(receipt.payload);
        if (this.harness.runtimeSupports(selectedRuntime, 'integrate') && result.status === 'completed') await this.harness.invokeBoundRuntime(projectId, runId, item.lease.dispatchId, 'integrate');
        else if (this.harness.runtimeSupports(selectedRuntime, 'discard')) { await this.harness.invokeBoundRuntime(projectId, runId, item.lease.dispatchId, 'discard'); result = { ...result, changedFiles: [] }; }
        const cleanupReceipt = this.harness.runtimeSupports(selectedRuntime, 'cleanup') ? await this.harness.invokeBoundRuntime(projectId, runId, item.lease.dispatchId, 'cleanup') : null;
        if (cleanupReceipt) cleanedAgents.add(item.lease.agentId);
        const output = await this.harness.recordResult(projectId, runId, item.dispatch.dispatchId, result, {
          commandId: `coordinator-submit-${item.dispatch.dispatchId}`,
          evidenceMetadata: { labels: ['agent-result', `runtime:${selectedRuntime}`] },
          runtimeEvidence: {
            wait: receipt,
            cleanup: cleanupReceipt,
            verificationReceipts: structuredClone(receipt.payload?.verificationReceipts ?? []),
          },
        });
        committed.push({ dispatchId: item.dispatch.dispatchId, featureId: item.dispatch.featureId, submissionId: output.result.submission.submissionId, status: output.result.featureState, runtimeReceipt: receipt, cleanupReceipt });
        state = output.state;
      }
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (this.harness.runtimeSupports(selectedRuntime, 'cleanup')) {
        const cleanupResults = await Promise.allSettled(spawned.filter(item => !cleanedAgents.has(item.lease.agentId)).map(item => this.harness.invokeBoundRuntime(projectId, runId, item.lease.dispatchId, 'cleanup')));
        const cleanupFailure = cleanupResults.find(result => result.status === 'rejected');
        if (!primaryError && cleanupFailure) throw cleanupFailure.reason;
      }
    }
    return { status: 'progressed', runtimePluginId: selectedRuntime, physicalLimit, committed, state };
  }

  async run({ projectId, runId, runtimePluginId, maxConcurrency, maxRounds = 100 } = {}) {
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
