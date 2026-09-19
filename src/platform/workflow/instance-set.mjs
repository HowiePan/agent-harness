import { isAbsolute, resolve } from 'node:path';
import { digestJson } from '../../common/canonical.mjs';
import { assert } from '../../common/errors.mjs';
import { WorkflowAdmissionStore } from './admission-store.mjs';

/** Command-side admission for independent Runs; each Run retains its own Authority. */
export const runWorkflowInstanceSet = async ({ harness, instances, commandId, maxConcurrentRuns = 1, providerCapacity = {}, admissionTimeoutMs = 600000, onGateProgress = () => {} }) => {
  assert(commandId && Array.isArray(instances) && instances.length > 0 && instances.length <= 100, 'INSTANCE_SET_INVALID', 'Instance Set requires command ID and 1-100 instances.');
  assert(Number.isInteger(maxConcurrentRuns) && maxConcurrentRuns >= 1 && maxConcurrentRuns <= 32, 'INSTANCE_CAPACITY_INVALID', 'Concurrent Run capacity must be 1-32.');
  const entries = [];
  const keys = new Set();
  const outputs = new Set();
  for (const [index, instance] of instances.entries()) {
    const instanceKey = instance.instanceKey ?? `${instance.projectId}:${instance.workflowId}:${instance.target}`;
    assert(!keys.has(instanceKey), 'INSTANCE_KEY_DUPLICATE', `Duplicate instance key: ${instanceKey}`);
    keys.add(instanceKey);
    const project = await harness.projectRegistry.get(instance.projectId);
    const workspaceRoot = resolve(instance.executionWorkspaceRoot ?? project.workspace.root);
    for (const outputPath of Object.values(instance.workflowInput?.outputPaths ?? {})) {
      assert(typeof outputPath === 'string' && outputPath && !isAbsolute(outputPath) && !outputPath.includes('..'), 'INSTANCE_OUTPUT_INVALID', 'Instance output path must be safe and relative.');
      const output = resolve(workspaceRoot, outputPath).toLowerCase();
      assert(!outputs.has(output), 'INSTANCE_OUTPUT_CONFLICT', `Multiple instances write ${output}.`);
      outputs.add(output);
    }
    entries.push({ index, instanceKey, workspaceRoot: workspaceRoot.toLowerCase(), providerKeys: [...new Set(instance.providerKeys ?? [])], input: structuredClone(instance) });
  }
  const setDigest = digestJson(entries.map(({ instanceKey, workspaceRoot, providerKeys, input }) => ({ instanceKey, workspaceRoot, providerKeys, input })));
  const admission = new WorkflowAdmissionStore({ controlRoot: harness.controlRoot, root: resolve(harness.dataRoot, 'workflow-admission'), authorityStore: harness.authorityStore });
  const pending = [...entries];
  const active = new Map();
  const results = new Array(entries.length);
  const canStart = entry => ![...active.values()].some(value => value.entry.workspaceRoot === entry.workspaceRoot)
    && entry.providerKeys.every(key => [...active.values()].filter(value => value.entry.providerKeys.includes(key)).length < (providerCapacity[key] ?? 1));
  const launch = entry => {
    const promise = (async () => {
      const { input } = entry;
      const requestId = `${commandId}.${entry.index}`;
      let plan = null;
      let acquired = false;
      let heartbeatTimer = null;
      await admission.enqueue({ requestId, projectId: input.projectId, workspaceRoot: entry.workspaceRoot, outputs: Object.values(input.workflowInput?.outputPaths ?? {}).map(path => resolve(entry.workspaceRoot, path).toLowerCase()), providerKeys: entry.providerKeys, maxConcurrentRuns, providerCapacity });
      try {
        const deadline = Date.now() + admissionTimeoutMs;
        while (!acquired) {
          acquired = (await admission.tryAcquire(requestId)).acquired;
          if (!acquired) {
            assert(Date.now() < deadline, 'INSTANCE_ADMISSION_TIMEOUT', `Instance ${entry.instanceKey} timed out waiting for resources.`);
            await new Promise(resolveWait => setTimeout(resolveWait, 250));
          }
        }
        plan = await harness.createLifecyclePlan(input);
        const preflightReport = await harness.createExecutionReadinessReport(plan, { onGateProgress });
        assert(preflightReport.executionReady, 'INSTANCE_PREFLIGHT_FAILED', `Instance ${entry.instanceKey} is not ready.`, { checks: preflightReport.checks.filter(check => !check.ready) });
        await admission.bindRun(requestId, plan.run.runId);
        heartbeatTimer = setInterval(() => { admission.heartbeat(requestId).catch(() => {}); }, 30000);
        const execute = plan.run.agentExecutionMode === 'conversation-visible' ? harness.executeVisibleLifecyclePlan : harness.executeLifecyclePlan;
        const outcome = await execute(plan, { commandId: requestId, preflightReport, onGateProgress });
        if (outcome.status === 'closed') await admission.release(requestId, 'closed');
        return { instanceKey: entry.instanceKey, workflow: plan.workflow ?? null, runId: outcome.state?.runId ?? plan.run.runId, planDigest: plan.planDigest, status: outcome.status, reason: outcome.reason ?? null };
      } catch (error) {
        if (acquired) {
          const current = plan ? await harness.authorityStore.read(input.projectId, plan.run.runId, { required: false }) : null;
          if (!current || ['closed', 'superseded'].includes(current.status)) await admission.release(requestId, 'failed-before-run');
        }
        throw error;
      } finally { if (heartbeatTimer) clearInterval(heartbeatTimer); }
    })().then(result => { results[entry.index] = result; }, error => { results[entry.index] = { instanceKey: entry.instanceKey, status: 'failed', code: error.code ?? 'UNEXPECTED_ERROR', message: error.message }; });
    active.set(entry.index, { entry, promise });
    promise.finally(() => active.delete(entry.index));
  };
  while (pending.length || active.size) {
    while (active.size < maxConcurrentRuns) {
      const index = pending.findIndex(canStart);
      if (index < 0) break;
      launch(pending.splice(index, 1)[0]);
    }
    if (active.size) await Promise.race([...active.values()].map(value => value.promise));
    else assert(!pending.length, 'INSTANCE_ADMISSION_DEADLOCK', 'No Instance can acquire its declared resources.');
  }
  return { schemaVersion: '1.0', setDigest, status: results.every(item => item.status === 'closed') ? 'closed' : 'attention-required', results };
};
