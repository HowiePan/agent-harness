import { assert } from '../common/errors.mjs';
import { AUTO_CONCURRENCY, AUTO_CONCURRENCY_LIMIT, resolveConcurrencyLimit } from '../common/concurrency.mjs';
import { RunCoordinator } from '../platform/workflow/coordinator/run-coordinator.mjs';
import { ProjectGateRunner, runPendingFeatureGates } from '../platform/workflow/gates/project-gate-runner.mjs';
import { isVisibleHostAdapter } from '../platform/plugins/runtime/visible-host-adapter.mjs';
import { canonicalize, digestJson, sha256 } from '../common/canonical.mjs';
import { assertInside } from '../common/paths.mjs';
import { atomicWrite } from '../kernel/atomic-io.mjs';
import { validateBusinessResult } from '../platform/execution/result-contract.mjs';
import { performance } from 'node:perf_hooks';

const recoverableResultCodes = new Set(['REPAIR_CHECKPOINT_REQUIRED', 'REPAIR_CHECKPOINT_EVIDENCE_REQUIRED', 'REPAIR_FINDING_CHECKPOINT_REQUIRED', 'QUALITY_DIAGNOSTIC_DISPOSITION_REQUIRED']);

const rejectVisibleResult = ({ error, result, receipt, runtimeReceipt, agentId, dispatchId, packetDigest }) => {
  const summary = `Agent result rejected by ${error.code}: ${error.message}`;
  const body = {
    kind: 'result-rejected-receipt', version: '1.0', agentId, dispatchId,
    packetDigest,
    promptDigest: runtimeReceipt.prompt.promptDigest,
    resultContractDigest: runtimeReceipt.resultContractDigest,
    code: error.code, nativeOutputDigest: digestJson(result),
    errors: structuredClone(error.details?.errors ?? []),
    observationRequestDigest: receipt.observationRequestDigest,
  };
  const rejection = { ...body, receiptDigest: digestJson(body) };
  return {
    result: { status: 'failed', summary, changedFiles: [], failureClass: 'runtime-contract', blocker: { kind: 'runtime-contract', summary, code: error.code } },
    rejection,
    receipt: { ...receipt, rejectionDigest: rejection.receiptDigest },
  };
};

export const executeHeadlessLifecyclePlan = async (context, api, planInput, { commandId, preflightReport, maxConcurrency, maxRounds = 100, forceFreshGates = true, onGateProgress = null } = {}) => {
  const { authorityStore } = context;
  assert(commandId, 'COMMAND_ID_REQUIRED', 'Lifecycle execution requires a command ID.');
  let started;
  try { started = await api.startLifecyclePlan(planInput, { commandId, preflightReport }); }
  catch (error) {
    if (error.code !== 'EXECUTION_READINESS_EXPIRED') throw error;
    const refreshed = await api.createExecutionReadinessReport(planInput, { onGateProgress });
    if (!refreshed.executionReady) return { status: 'attention-required', reason: 'refreshed-execution-readiness-not-ready', preflightReport: refreshed };
    started = await api.startLifecyclePlan(planInput, { commandId, preflightReport: refreshed });
  }
  if (started.status === 'attention-required') return started;
  const { plan, runtimePolicy } = started;
  let { state } = started;
  if (state.status === 'closed') return { status: 'closed', planDigest: plan.planDigest, state };
  assert(state.status !== 'superseded', 'LIFECYCLE_PLAN_RUN_SUPERSEDED', 'Lifecycle execution cannot resume a superseded Run.');
  if (runtimePolicy.hostOrchestrated) return { status: 'attention-required', reason: 'user-visible-runtime-requires-host-orchestration', planDigest: plan.planDigest, state };
  const activeRunId = state.runId;
  const coordinator = new RunCoordinator({ harness: api, onGateProgress });
  const execution = await coordinator.run({ projectId: plan.project.id, runId: activeRunId, runtimePluginId: plan.run.runtimePluginId, maxConcurrency, maxRounds });
  state = await authorityStore.read(plan.project.id, activeRunId);
  if (!state.features.every(feature => feature.state === 'completed')) return { status: execution.status, planDigest: plan.planDigest, execution, state };
  const gateRunner = new ProjectGateRunner({ harness: api, onProgress: onGateProgress });
  const featureGates = await runPendingFeatureGates({ harness: api, projectId: plan.project.id, runId: activeRunId, onProgress: onGateProgress });
  if (!featureGates.ok) return { status: 'attention-required', reason: 'feature-gates-not-passed', planDigest: plan.planDigest, execution, gates: featureGates.results, state: featureGates.state };
  const stableGateIds = (featureGates.state.metadata?.gateRecipes ?? []).filter(recipe => recipe.scope === 'stable' && recipe.required !== false).map(recipe => recipe.id);
  if (stableGateIds.length) {
    const stable = await gateRunner.run({ projectId: plan.project.id, runId: activeRunId, scope: 'stable', forceFresh: true, gateIds: stableGateIds });
    if (!stable.results.every(gate => gate.status === 'passed')) return { status: 'attention-required', reason: 'stable-gates-not-passed', planDigest: plan.planDigest, execution, gates: stable, state: stable.state };
  }
  const gates = plan.stopCondition.requiredFinalGates?.length
    ? await gateRunner.run({ projectId: plan.project.id, runId: activeRunId, scope: 'final', forceFresh: forceFreshGates, gateIds: plan.stopCondition.requiredFinalGates })
    : { results: [], state };
  state = await authorityStore.read(plan.project.id, activeRunId);
  if (!gates.results.every(gate => gate.status === 'passed')) return { status: 'attention-required', reason: 'final-gates-not-passed', planDigest: plan.planDigest, execution, gates, state };
  const closure = api.profileRegistry.get(state.profile.id).canClose(state);
  if (!closure.ok) return { status: 'attention-required', reason: closure.reason, planDigest: plan.planDigest, execution, gates, state };
  const closed = await api.kernel.closeRun(plan.project.id, activeRunId, {}, { expectedRevision: state.revision, commandId: `${commandId}.close` });
  return { status: 'closed', planDigest: plan.planDigest, execution, gates, state: closed.state };
};

export const executeVisibleLifecyclePlan = async (context, api, planInput, { commandId, preflightReport, maxConcurrency, maxRounds = 100, forceFreshGates = true, onGateProgress = null, gateDiagnosticAttempts = 0 } = {}) => {
  const { authorityStore, projectRegistry, pluginHost, resolveVisibleHostAdapter } = context;
  assert(commandId, 'COMMAND_ID_REQUIRED', 'Visible lifecycle execution requires a command ID.');
  let started;
  try { started = await api.startLifecyclePlan(planInput, { commandId, preflightReport }); }
  catch (error) {
    if (error.code !== 'EXECUTION_READINESS_EXPIRED') throw error;
    const refreshed = await api.createExecutionReadinessReport(planInput, { onGateProgress });
    if (!refreshed.executionReady) return { status: 'attention-required', reason: 'refreshed-execution-readiness-not-ready', preflightReport: refreshed };
    started = await api.startLifecyclePlan(planInput, { commandId, preflightReport: refreshed });
  }
  if (started.status === 'attention-required' || started.status === 'closed') return started;
  const { plan, runtimePolicy } = started;
  assert(runtimePolicy.hostOrchestrated, 'VISIBLE_LIFECYCLE_RUNTIME_REQUIRED', 'Visible lifecycle execution requires a host-orchestrated Runtime.');
  const trustedAgentAdapter = resolveVisibleHostAdapter(plan.run.runtimePluginId);
  assert(isVisibleHostAdapter(trustedAgentAdapter) && ['spawn', 'wait', 'result', 'reconcile', 'confirm', 'contain'].every(capability => trustedAgentAdapter.capabilities?.[capability]), 'VISIBLE_AGENT_HOST_COORDINATOR_UNAVAILABLE', 'Visible lifecycle execution requires a complete trusted Host Coordinator adapter.');
  const project = await projectRegistry.get(plan.project.id);
  const runtimeManifest = pluginHost.get(plan.run.runtimePluginId, 'agent-runtime').manifest;
  const configuredLimit = resolveConcurrencyLimit(project.policy?.maxConcurrency, project.policy?.maxConcurrency === AUTO_CONCURRENCY ? AUTO_CONCURRENCY_LIMIT : 1);
  const requestedLimit = resolveConcurrencyLimit(maxConcurrency, configuredLimit);
  const physicalLimit = runtimeManifest.capabilities.includes('workspace-shared') ? 1 : requestedLimit;
  let state = started.state;
  const activeRunId = state.runId;
  const rounds = [];
  const blockedFeatures = current => current.features
    .filter(feature => ['blocked', 'failed-budget'].includes(feature.state))
    .map(feature => ({
      id: feature.id,
      state: feature.state,
      blocker: structuredClone(feature.blocker ?? null),
      allowedPaths: [...feature.allowedPaths],
      verificationOutputPaths: [...(feature.metadata?.verificationOutputPaths ?? [])],
    }));
  const retryFailedGates = async results => {
    if (gateDiagnosticAttempts >= 5 || !results.some(gate => gate.status === 'failed')) return null;
    state = await authorityStore.read(plan.project.id, activeRunId);
    if (!api.profileRegistry.get(state.profile.id).createGateDiagnosticReview) return null;
    const scheduled = await api.kernel.scheduleGateDiagnosticReview(plan.project.id, activeRunId, { gateResults: results }, { expectedRevision: state.revision, commandId: `${commandId}.gate-diagnostic.${state.revision}` });
    if (!scheduled.result.scheduled) return null;
    const resumed = await executeVisibleLifecyclePlan(context, api, planInput, { commandId, preflightReport, maxConcurrency, maxRounds, forceFreshGates, onGateProgress, gateDiagnosticAttempts: gateDiagnosticAttempts + 1 });
    return { ...resumed, rounds: [...rounds, ...(resumed.rounds ?? [])] };
  };
  for (let round = 1; round <= maxRounds; round += 1) {
    const roundStarted = performance.now();
    const timing = { spawnMs: 0, waitMs: 0, resultMs: 0 };
    state = await authorityStore.read(plan.project.id, activeRunId);
    if (state.status === 'closed') return { status: 'closed', planDigest: plan.planDigest, rounds, state };
    const activeLeases = state.leases.filter(lease => lease.status === 'active');
    let featureGates = null;
    if (!activeLeases.length) {
      featureGates = await runPendingFeatureGates({ harness: api, projectId: plan.project.id, runId: activeRunId, onProgress: onGateProgress });
      state = featureGates.state;
      let requested = state.dispatches.filter(dispatch => dispatch.status === 'requested');
      if (!requested.length && !state.features.every(feature => feature.state === 'completed')) {
        const scheduled = await api.dispatch(plan.project.id, activeRunId, { maxConcurrency: physicalLimit, runtimePluginId: plan.run.runtimePluginId }, { expectedRevision: state.revision, commandId: `${commandId}.schedule.${state.revision}` });
        state = scheduled.state;
        requested = scheduled.result.dispatches;
      }
      for (const dispatch of requested.slice(0, physicalLimit)) {
        const compiled = await api.readDispatchPacket(plan.project.id, activeRunId, dispatch.dispatchId);
        if (compiled.prompt.contractVersion === '1.4') {
          const packetFile = assertInside(authorityStore.root, `${compiled.packet.outputRef}.dispatch-packet.json`, 'Dispatch packet transport');
          const packetBytes = canonicalize(compiled.packet);
          assert(sha256(packetBytes) === compiled.prompt.packetDigest, 'DISPATCH_PACKET_TRANSPORT_DIGEST_MISMATCH', 'Dispatch packet transport differs from the generated Prompt.');
          await atomicWrite(packetFile, packetBytes, { root: authorityStore.root });
        }
        let spawned = null;
        let runtimeReceipt = null;
        try {
          const spawnStarted = performance.now();
          spawned = await trustedAgentAdapter.spawn({
            projectId: plan.project.id,
            runId: activeRunId,
            dispatchId: dispatch.dispatchId,
            packetDigest: dispatch.packetDigest,
            promptDigest: compiled.prompt.promptDigest,
            prompt: compiled.prompt.text,
            packet: structuredClone(compiled.packet),
          });
          timing.spawnMs += performance.now() - spawnStarted;
          assert(spawned?.agentId && spawned.visibility?.mode === 'user-visible' && spawned.visibility.surface && spawned.visibility.inspectRef, 'VISIBLE_AGENT_HOST_SPAWN_RECEIPT_INVALID', 'Host spawn must return an Agent identity and inspectable user-visible task reference.');
          state = await authorityStore.read(plan.project.id, activeRunId);
          runtimeReceipt = {
            runtimePluginId: plan.run.runtimePluginId,
            agentId: spawned.agentId,
            dispatchId: dispatch.dispatchId,
            packetDigest: dispatch.packetDigest,
            resultContractDigest: dispatch.execution?.result?.contractDigest ?? null,
            prompt: { contractVersion: compiled.prompt.contractVersion, codecPluginId: compiled.prompt.codecPluginId, codecPluginVersion: compiled.prompt.codecPluginVersion, packetDigest: compiled.prompt.packetDigest, promptDigest: compiled.prompt.promptDigest },
            visibility: structuredClone(spawned.visibility),
            hostSpawnReceipt: structuredClone(spawned.receipt ?? null),
          };
          await api.bindDispatch(plan.project.id, activeRunId, { dispatchId: dispatch.dispatchId, agentId: spawned.agentId, runtimeReceipt }, { expectedRevision: state.revision, commandId: `${commandId}.bind.${dispatch.dispatchId}` });
        } catch (error) {
          if (spawned && error.details?.leaseBound !== true) {
            try {
              await trustedAgentAdapter.contain({ agentId: spawned.agentId, dispatchId: dispatch.dispatchId, runtimeReceipt, hostSpawnReceipt: spawned.receipt ?? null, reason: error.code ?? 'lease-bind-failed' });
            } catch (containmentError) {
              error.details = { ...(error.details ?? {}), containmentError: { code: containmentError.code ?? 'VISIBLE_AGENT_HOST_CONTAINMENT_FAILED', message: containmentError.message } };
            }
          }
          throw error;
        }
      }
    }
    state = await authorityStore.read(plan.project.id, activeRunId);
    const leases = state.leases.filter(lease => lease.status === 'active');
    if (!leases.length) {
      if (state.features.every(feature => feature.state === 'completed')) break;
      if (featureGates && !featureGates.ok) return { status: 'attention-required', reason: 'feature-gates-not-passed', planDigest: plan.planDigest, rounds, gates: featureGates.results, state };
      rounds.push({ round, status: 'attention-required', reason: state.status });
      return { status: 'attention-required', reason: state.status, planDigest: plan.planDigest, rounds, blockedFeatures: blockedFeatures(state), state };
    }
    for (const lease of leases) {
      const dispatch = state.dispatches.find(item => item.dispatchId === lease.dispatchId);
      const waitStarted = performance.now();
      const waited = await trustedAgentAdapter.wait({ agentId: lease.agentId, dispatchId: lease.dispatchId, visibility: structuredClone(lease.runtimeReceipt.visibility), runtimeReceipt: structuredClone(lease.runtimeReceipt) });
      timing.waitMs += performance.now() - waitStarted;
      state = await authorityStore.read(plan.project.id, activeRunId);
      const heartbeat = await api.recordHeartbeat(plan.project.id, activeRunId, { leaseId: lease.leaseId, dispatchId: lease.dispatchId, agentId: lease.agentId, progress: waited?.progress ?? waited?.status ?? 'completed' }, { expectedRevision: state.revision, commandId: `${commandId}.heartbeat.${lease.dispatchId}.${state.revision}` });
      state = heartbeat.state;
      if (!['completed', 'failed', 'blocked'].includes(waited?.status)) continue;
      const resultStarted = performance.now();
      const transported = await trustedAgentAdapter.result({ agentId: lease.agentId, dispatchId: lease.dispatchId, visibility: structuredClone(lease.runtimeReceipt.visibility), runtimeReceipt: structuredClone(lease.runtimeReceipt) });
      timing.resultMs += performance.now() - resultStarted;
      assert(transported?.result, 'VISIBLE_AGENT_STRUCTURED_RESULT_REQUIRED', 'Host result transport must return a structured Agent result.');
      const feature = state.features.find(item => item.id === dispatch.featureId);
      let businessResult = transported.result;
      let hostResultReceipt = transported.receipt ?? null;
      let runtimeEvidence = transported.runtimeEvidence ?? {};
      let rejected = null;
      try { validateBusinessResult(businessResult, { conversationVisible: true, repair: Boolean(feature?.metadata?.repairFindingId), feature }); }
      catch (error) {
        if (!recoverableResultCodes.has(error.code) || businessResult.status !== 'completed' || !hostResultReceipt?.observationRequestDigest) throw error;
        if (error.code.startsWith('REPAIR_') && !feature?.metadata?.repairFindingId) throw error;
        if (error.code.startsWith('QUALITY_') && !feature?.metadata?.qualityReview) throw error;
        rejected = rejectVisibleResult({ error, result: businessResult, receipt: hostResultReceipt, runtimeReceipt: lease.runtimeReceipt, agentId: lease.agentId, dispatchId: dispatch.dispatchId, packetDigest: dispatch.packetDigest });
        businessResult = rejected.result;
        hostResultReceipt = rejected.receipt;
        runtimeEvidence = { ...runtimeEvidence, resultRejection: rejected.rejection };
      }
      const submitted = await api.recordResult(plan.project.id, activeRunId, dispatch.dispatchId, businessResult, { commandId: `${commandId}.submit.${dispatch.dispatchId}`, runtimeEvidence: { ...runtimeEvidence, hostWaitReceipt: waited?.receipt ?? null, hostResultReceipt } });
      state = submitted.state;
      if (rejected && submitted.result.featureState === 'blocked') {
        const reopened = await api.kernel.reopenFeature(plan.project.id, activeRunId, {
          featureId: feature.id,
          reason: `${rejected.rejection.code}: report only observed passing checkpoints for a repair and provide evidence-backed dispositions for every carried diagnostic in a review. Reinspect the current source before reporting completion.`,
        }, { expectedRevision: state.revision, commandId: `${commandId}.reopen.${dispatch.dispatchId}` });
        state = reopened.state;
      }
    }
    rounds.push({ round, status: 'progressed', revision: state.revision, physicalLimit, timing: Object.fromEntries(Object.entries(timing).map(([key, value]) => [key, Math.round(value)])), elapsedMs: Math.round(performance.now() - roundStarted) });
  }
  state = await authorityStore.read(plan.project.id, activeRunId);
  if (!state.features.every(feature => feature.state === 'completed')) return { status: 'attention-required', reason: 'visible-coordinator-round-limit', planDigest: plan.planDigest, rounds, state };
  const gateRunner = new ProjectGateRunner({ harness: api, onProgress: onGateProgress });
  const featureGates = await runPendingFeatureGates({ harness: api, projectId: plan.project.id, runId: activeRunId, onProgress: onGateProgress });
  if (!featureGates.ok) return { status: 'attention-required', reason: 'feature-gates-not-passed', planDigest: plan.planDigest, rounds, gates: featureGates.results, state: featureGates.state };
  const stableGateIds = (featureGates.state.metadata?.gateRecipes ?? []).filter(recipe => recipe.scope === 'stable' && recipe.required !== false).map(recipe => recipe.id);
  if (stableGateIds.length) {
    const stable = await gateRunner.run({ projectId: plan.project.id, runId: activeRunId, scope: 'stable', forceFresh: true, gateIds: stableGateIds });
    if (!stable.results.every(gate => gate.status === 'passed')) return await retryFailedGates(stable.results) ?? { status: 'attention-required', reason: 'stable-gates-not-passed', planDigest: plan.planDigest, rounds, gates: stable, state: stable.state };
  }
  const gates = plan.stopCondition.requiredFinalGates?.length
    ? await gateRunner.run({ projectId: plan.project.id, runId: activeRunId, scope: 'final', forceFresh: forceFreshGates, gateIds: plan.stopCondition.requiredFinalGates })
    : { results: [], state };
  state = await authorityStore.read(plan.project.id, activeRunId);
  if (!gates.results.every(gate => gate.status === 'passed')) return await retryFailedGates(gates.results) ?? { status: 'attention-required', reason: 'final-gates-not-passed', planDigest: plan.planDigest, rounds, gates, state };
  const closure = api.profileRegistry.get(state.profile.id).canClose(state);
  if (!closure.ok) return { status: 'attention-required', reason: closure.reason, planDigest: plan.planDigest, rounds, gates, state };
  const closed = await api.kernel.closeRun(plan.project.id, activeRunId, {}, { expectedRevision: state.revision, commandId: `${commandId}.close` });
  return { status: 'closed', planDigest: plan.planDigest, rounds, gates, state: closed.state };
};
