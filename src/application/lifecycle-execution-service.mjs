import { assert } from '../common/errors.mjs';
import { AUTO_CONCURRENCY, AUTO_CONCURRENCY_LIMIT, resolveConcurrencyLimit } from '../common/concurrency.mjs';
import { RunCoordinator } from '../platform/workflow/coordinator/run-coordinator.mjs';
import { ProjectGateRunner, runPendingFeatureGates } from '../platform/workflow/gates/project-gate-runner.mjs';
import { isVisibleHostAdapter } from '../platform/plugins/runtime/visible-host-adapter.mjs';
import { canonicalize, digestJson, sha256 } from '../common/canonical.mjs';
import { assertInside } from '../common/paths.mjs';
import { atomicWrite } from '../kernel/atomic-io.mjs';
import { validateBusinessResult, validateProfileResult } from '../platform/execution/result-contract.mjs';
import { ensureVersionClearance } from './version-clearance.mjs';
import { ensurePreReleaseCandidate } from './version-prerelease.mjs';
import { ensureBatchPreReleaseCandidate } from './batch-prerelease.mjs';
import { verifyCollectionScenarioInventories } from './collection-exhaustion.mjs';
import { ensurePlanApprovalArtifact } from '../flows/delivery-lifecycle/plan-approval.mjs';
import { performance } from 'node:perf_hooks';

const recoverableResultCodes = new Set(['REPAIR_CHECKPOINT_REQUIRED', 'REPAIR_CHECKPOINT_EVIDENCE_REQUIRED', 'REPAIR_FINDING_CHECKPOINT_REQUIRED', 'QUALITY_DIAGNOSTIC_DISPOSITION_REQUIRED', 'PROFILE_RESULT_REJECTED']);
export const visibleLifecycleStopReason = state => {
  if (state.profile?.id === 'collection-batch' && state.features.some(feature => ['blocked', 'failed-budget'].includes(feature.state)
    && feature.blocker?.kind !== 'engine-artifact')) return 'collection-attention-required';
  return state.status === 'ready' && state.features.some(feature => ['blocked', 'failed-budget'].includes(feature.state))
    ? 'blocked-dependencies' : state.status;
};
const safeProjectPath = path => typeof path === 'string' && path.length > 0 && !path.includes('\\')
  && !path.includes(':') && !path.startsWith('/') && path.split('/').every(segment => segment && segment !== '.' && segment !== '..' && !segment.includes('*'));
const insideScope = (scope, path) => path === scope || path.startsWith(`${scope}/`);
export const shouldRetryImplementationVerificationPath = ({ feature, result, state }) => {
  if (feature?.metadata?.stage !== 'implementation' || result?.status !== 'blocked' || result.failureClass !== 'verification-path-prohibited') return false;
  const candidates = result.blocker?.repairCandidatePaths;
  if (!Array.isArray(candidates) || !candidates.length || !candidates.every(path => safeProjectPath(path)
    && feature.allowedPaths?.some(scope => safeProjectPath(scope) && insideScope(scope, path))
    && !feature.forbiddenPaths?.some(scope => safeProjectPath(scope) && insideScope(scope, path)))) return false;
  const retries = feature.metadata.verificationRepairRetries;
  if (!Number.isInteger(retries) || retries < 1) return false;
  const current = state.features.find(item => item.id === feature.id);
  const attempt = state.attempts[`${feature.logicalRoot}:${result.failureClass}`];
  return current?.state === 'blocked' && attempt && !attempt.exhausted && attempt.failures <= retries;
};
export const shouldContinueImplementationProgress = ({ feature, result, state, submission }) => {
  if (feature?.metadata?.stage !== 'implementation' || result?.status !== 'blocked'
    || !['implementation-incomplete', 'external-prerequisite-and-incomplete-implementation'].includes(result.failureClass)) return false;
  const current = state.features.find(item => item.id === feature.id);
  if (current?.state !== 'blocked' || !submission || submission.featureId !== feature.id
    || submission.outputSourceDigest === submission.inputSourceDigest
    || !Array.isArray(submission.changedFiles) || !submission.changedFiles.length) return false;
  const seenSource = state.submissions.some(item => item.submissionId !== submission.submissionId
    && item.featureId === feature.id
    && [item.inputSourceDigest, item.outputSourceDigest].includes(submission.outputSourceDigest));
  if (seenSource) return false;
  const budget = feature.metadata.implementationProgressRetries;
  if (!Number.isInteger(budget) || budget < 1) return false;
  const continuations = state.submissions.filter(item => item.featureId === feature.id
    && item.result?.status === 'blocked'
    && ['implementation-incomplete', 'external-prerequisite-and-incomplete-implementation'].includes(item.result.failureClass)).length;
  const attempt = state.attempts[`${feature.logicalRoot}:${result.failureClass}`];
  return continuations <= budget && Boolean(attempt && !attempt.exhausted);
};
export const shouldContinueCollectionProgress = ({ feature, result, state, submission }) => {
  const expectedClass = feature?.metadata?.stage === 'shared-capability' ? 'collection-shared-incomplete'
    : feature?.metadata?.stage === 'produce' && state.profile?.id === 'collection-batch' ? 'collection-game-incomplete' : null;
  if (!expectedClass || result?.status !== 'blocked' || result.failureClass !== expectedClass) return false;
  const current = state.features.find(item => item.id === feature.id);
  if (current?.state !== 'blocked' || !submission || submission.featureId !== feature.id
    || submission.outputSourceDigest === submission.inputSourceDigest || !submission.changedFiles?.length) return false;
  const budget = feature.metadata.collectionProgressRetries;
  const attempt = state.attempts[`${feature.logicalRoot}:${expectedClass}`];
  if (!Number.isInteger(budget) || budget < 1 || !attempt || attempt.exhausted || attempt.failures > budget) return false;
  return !state.submissions.some(item => item.submissionId !== submission.submissionId && item.featureId === feature.id
    && [item.inputSourceDigest, item.outputSourceDigest].includes(submission.outputSourceDigest));
};
const previousFreshGates = (state, scope, ids) => {
  const results = ids.map(id => [...state.gates].reverse().find(gate => gate.id === id && gate.scope === scope && gate.status === 'passed' && gate.forcedFresh && gate.sourceDigest === state.sourceDigest));
  return results.every(Boolean) ? { results, state } : null;
};
const completionReceipts = async (api, dataRoot, plan, state) => ({
  planApprovalArtifact: await ensurePlanApprovalArtifact(dataRoot, state),
  versionClearance: await ensureVersionClearance(dataRoot, state),
  prereleaseCandidate: state.metadata?.commandIntent?.action === 'prerelease' && !state.metadata.commandIntent.batchClearance
    ? await ensurePreReleaseCandidate({ dataRoot, project: await api.projectRegistry.get(plan.project.id), state, workspaceRoot: plan.run.executionWorkspaceRoot })
    : null,
  ...(state.metadata?.commandIntent?.action === 'prerelease' && state.metadata.commandIntent.batchClearance
    ? { batchPrereleaseCandidate: await ensureBatchPreReleaseCandidate({ dataRoot, project: await api.projectRegistry.get(plan.project.id), state, workspaceRoot: plan.run.executionWorkspaceRoot }) }
    : {}),
});

const rejectVisibleResult = ({ error, result, receipt, runtimeReceipt, agentId, dispatchId, packetDigest }) => {
  const summary = `Agent result rejected by ${error.code}: ${error.message}${error.details?.reason ? ` (${error.details.reason})` : ''}`;
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

const runHeadlessLifecyclePlan = async (context, api, planInput, { commandId, preflightReport, maxConcurrency, maxRounds = 100, forceFreshGates = true, onGateProgress = null } = {}) => {
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
  if (state.status === 'closed') return { status: 'closed', planDigest: plan.planDigest, state, ...await completionReceipts(api, authorityStore.root, plan, state) };
  assert(state.status !== 'superseded', 'LIFECYCLE_PLAN_RUN_SUPERSEDED', 'Lifecycle execution cannot resume a superseded Run.');
  if (runtimePolicy.hostOrchestrated) return { status: 'attention-required', reason: 'user-visible-runtime-requires-host-orchestration', planDigest: plan.planDigest, state };
  const activeRunId = state.runId;
  const coordinator = new RunCoordinator({ harness: api, onGateProgress });
  const execution = await coordinator.run({ projectId: plan.project.id, runId: activeRunId, runtimePluginId: plan.run.runtimePluginId, maxConcurrency,
    maxRounds: plan.intent.preset === 'release-exhaustive' || (plan.intent.action === 'produce' && state.profile.id === 'collection-batch') ? Infinity : maxRounds });
  state = await authorityStore.read(plan.project.id, activeRunId);
  if (!state.features.every(feature => feature.state === 'completed')) {
    if (state.profile.id === 'collection-batch' && plan.intent.action === 'produce') {
      const exhaustion = api.profileRegistry.get(state.profile.id).project(state).collectionExhaustion;
      if (exhaustion?.onlyEngineRemaining && plan.stopCondition.requiredFinalGates?.includes('collection-produce-exhaustion-verify')) {
        const inventory = await verifyCollectionScenarioInventories({ workspaceRoot: plan.run.executionWorkspaceRoot, state });
        if (!inventory.ok) return { status: 'attention-required', reason: 'collection-scenario-inventory-mismatch', planDigest: plan.planDigest,
          execution, collectionExhaustion: exhaustion, inventory, state };
        const gateRunner = new ProjectGateRunner({ harness: api, onProgress: onGateProgress });
        const gates = await gateRunner.run({ projectId: plan.project.id, runId: activeRunId, scope: 'final', forceFresh: true,
          gateIds: plan.stopCondition.requiredFinalGates });
        return { status: 'attention-required', reason: gates.results.every(gate => gate.status === 'passed') ? 'engine-only-blocked' : 'collection-exhaustion-gates-not-passed',
          planDigest: plan.planDigest, execution, gates: gates.results, collectionExhaustion: exhaustion, inventory, state: gates.state };
      }
    }
    return { status: execution.status, planDigest: plan.planDigest, execution, state };
  }
  const gateRunner = new ProjectGateRunner({ harness: api, onProgress: onGateProgress });
  const featureGates = await runPendingFeatureGates({ harness: api, projectId: plan.project.id, runId: activeRunId, onProgress: onGateProgress });
  if (!featureGates.ok) return { status: 'attention-required', reason: 'feature-gates-not-passed', planDigest: plan.planDigest, execution, gates: featureGates.results, state: featureGates.state };
  const stableGateIds = (featureGates.state.metadata?.gateRecipes ?? []).filter(recipe => recipe.scope === 'stable' && recipe.required !== false).map(recipe => recipe.id);
  if (stableGateIds.length) {
    const stable = (state.profile.config.repairOnly ? previousFreshGates(featureGates.state, 'stable', stableGateIds) : null) ?? await gateRunner.run({ projectId: plan.project.id, runId: activeRunId, scope: 'stable', forceFresh: true, gateIds: stableGateIds });
    if (!stable.results.every(gate => gate.status === 'passed')) return { status: 'attention-required', reason: 'stable-gates-not-passed', planDigest: plan.planDigest, execution, gates: stable, state: stable.state };
  }
  const gates = plan.stopCondition.requiredFinalGates?.length
    ? (state.profile.config.repairOnly ? previousFreshGates(state, 'final', plan.stopCondition.requiredFinalGates) : null) ?? await gateRunner.run({ projectId: plan.project.id, runId: activeRunId, scope: 'final', forceFresh: forceFreshGates, gateIds: plan.stopCondition.requiredFinalGates })
    : { results: [], state };
  state = await authorityStore.read(plan.project.id, activeRunId);
  if (!gates.results.every(gate => gate.status === 'passed')) return { status: 'attention-required', reason: 'final-gates-not-passed', planDigest: plan.planDigest, execution, gates, state };
  const closure = api.profileRegistry.get(state.profile.id).canClose(state);
  if (!closure.ok) return { status: 'attention-required', reason: closure.reason, planDigest: plan.planDigest, execution, gates, state };
  const closed = await api.kernel.closeRun(plan.project.id, activeRunId, {}, { expectedRevision: state.revision, commandId: `${commandId}.close` });
  return { status: 'closed', planDigest: plan.planDigest, execution, gates, state: closed.state, ...await completionReceipts(api, authorityStore.root, plan, closed.state) };
};

const continueVisibleLifecyclePlan = async (context, api, planInput, { commandId, preflightReport, maxConcurrency, maxRounds = 100, forceFreshGates = true, onGateProgress = null, gateDiagnosticAttempts = 0, continuedStart = null } = {}) => {
  const { authorityStore, projectRegistry, pluginHost, resolveVisibleHostAdapter } = context;
  assert(commandId, 'COMMAND_ID_REQUIRED', 'Visible lifecycle execution requires a command ID.');
  let started = continuedStart;
  if (!started) {
    try { started = await api.startLifecyclePlan(planInput, { commandId, preflightReport }); }
    catch (error) {
      if (error.code !== 'EXECUTION_READINESS_EXPIRED') throw error;
      const refreshed = await api.createExecutionReadinessReport(planInput, { onGateProgress });
      if (!refreshed.executionReady) return { status: 'attention-required', reason: 'refreshed-execution-readiness-not-ready', preflightReport: refreshed };
      started = await api.startLifecyclePlan(planInput, { commandId, preflightReport: refreshed });
    }
  }
  if (started.status === 'attention-required') return started;
  if (started.status === 'closed') return { ...started, ...await completionReceipts(api, authorityStore.root, started.plan ?? planInput, started.state) };
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
    if (plan.intent.action === 'prerelease') return null;
    if (gateDiagnosticAttempts >= 5 || !results.some(gate => gate.status === 'failed')) return null;
    state = await authorityStore.read(plan.project.id, activeRunId);
    if (!api.profileRegistry.get(state.profile.id).createGateDiagnosticReview) return null;
    const scheduled = await api.kernel.scheduleGateDiagnosticReview(plan.project.id, activeRunId, { gateResults: results }, { expectedRevision: state.revision, commandId: `${commandId}.gate-diagnostic.${state.revision}` });
    if (!scheduled.result.scheduled) return null;
    const resumed = await continueVisibleLifecyclePlan(context, api, planInput, { commandId, preflightReport, maxConcurrency, maxRounds, forceFreshGates, onGateProgress, gateDiagnosticAttempts: gateDiagnosticAttempts + 1, continuedStart: started });
    return { ...resumed, rounds: [...rounds, ...(resumed.rounds ?? [])] };
  };
  const coordinatorRoundLimit = plan.intent.preset === 'release-exhaustive' || plan.intent.action === 'implement'
    || (plan.intent.action === 'produce' && state.profile.id === 'collection-batch') ? Infinity : maxRounds;
  let completedRounds = 0;
  while (completedRounds < coordinatorRoundLimit) {
    const roundStarted = performance.now();
    const timing = { spawnMs: 0, waitMs: 0, resultMs: 0 };
    state = await authorityStore.read(plan.project.id, activeRunId);
    if (state.status === 'closed') return { status: 'closed', planDigest: plan.planDigest, rounds, state, ...await completionReceipts(api, authorityStore.root, plan, state) };
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
        if (['1.4', '1.5'].includes(compiled.prompt.contractVersion)) {
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
      if (featureGates && !featureGates.ok) {
        if (state.profile.id === 'collection-batch' && plan.intent.action === 'produce') {
          const retried = await retryFailedGates(featureGates.results);
          if (retried) return retried;
        }
        return { status: 'attention-required', reason: 'feature-gates-not-passed', planDigest: plan.planDigest, rounds, gates: featureGates.results, state };
      }
      if (state.profile.id === 'collection-batch' && plan.intent.action === 'produce') {
        const exhaustion = api.profileRegistry.get(state.profile.id).project(state).collectionExhaustion;
        if (exhaustion?.onlyEngineRemaining && plan.stopCondition.requiredFinalGates?.includes('collection-produce-exhaustion-verify')) {
          const inventory = await verifyCollectionScenarioInventories({ workspaceRoot: plan.run.executionWorkspaceRoot, state });
          if (!inventory.ok) return { status: 'attention-required', reason: 'collection-scenario-inventory-mismatch', planDigest: plan.planDigest,
            rounds, collectionExhaustion: exhaustion, inventory, blockedFeatures: blockedFeatures(state), state };
          const gateRunner = new ProjectGateRunner({ harness: api, onProgress: onGateProgress });
          const gates = await gateRunner.run({ projectId: plan.project.id, runId: activeRunId, scope: 'final', forceFresh: true,
            gateIds: plan.stopCondition.requiredFinalGates });
          state = gates.state;
          if (!gates.results.every(gate => gate.status === 'passed')) return await retryFailedGates(gates.results)
            ?? { status: 'attention-required', reason: 'collection-exhaustion-gates-not-passed', planDigest: plan.planDigest, rounds, gates: gates.results, state };
          return { status: 'attention-required', reason: 'engine-only-blocked', planDigest: plan.planDigest,
            rounds, gates: gates.results, collectionExhaustion: exhaustion, inventory, blockedFeatures: blockedFeatures(state), state };
        }
      }
      const reason = visibleLifecycleStopReason(state);
      rounds.push({ round: completedRounds + 1, status: 'attention-required', reason });
      return { status: 'attention-required', reason, planDigest: plan.planDigest, rounds, blockedFeatures: blockedFeatures(state), state };
    }
    let terminalLeaseObserved = false;
    for (const lease of leases) {
      const dispatch = state.dispatches.find(item => item.dispatchId === lease.dispatchId);
      const waitStarted = performance.now();
      const waited = await trustedAgentAdapter.wait({ agentId: lease.agentId, dispatchId: lease.dispatchId, visibility: structuredClone(lease.runtimeReceipt.visibility), runtimeReceipt: structuredClone(lease.runtimeReceipt) });
      timing.waitMs += performance.now() - waitStarted;
      state = await authorityStore.read(plan.project.id, activeRunId);
      const heartbeat = await api.recordHeartbeat(plan.project.id, activeRunId, { leaseId: lease.leaseId, dispatchId: lease.dispatchId, agentId: lease.agentId, progress: waited?.progress ?? waited?.status ?? 'completed' }, { expectedRevision: state.revision, commandId: `${commandId}.heartbeat.${lease.dispatchId}.${state.revision}` });
      state = heartbeat.state;
      if (!['completed', 'failed', 'blocked'].includes(waited?.status)) continue;
      terminalLeaseObserved = true;
      const resultStarted = performance.now();
      const transported = await trustedAgentAdapter.result({ agentId: lease.agentId, dispatchId: lease.dispatchId, visibility: structuredClone(lease.runtimeReceipt.visibility), runtimeReceipt: structuredClone(lease.runtimeReceipt) });
      timing.resultMs += performance.now() - resultStarted;
      assert(transported?.result, 'VISIBLE_AGENT_STRUCTURED_RESULT_REQUIRED', 'Host result transport must return a structured Agent result.');
      // Native result observation can outlast the Lease heartbeat window. Renew
      // through the trusted Host adapter after transport, before submission.
      state = await authorityStore.read(plan.project.id, activeRunId);
      const resultHeartbeat = await api.recordHeartbeat(plan.project.id, activeRunId, {
        leaseId: lease.leaseId, dispatchId: lease.dispatchId, agentId: lease.agentId, progress: 'result-observed',
      }, { expectedRevision: state.revision, commandId: `${commandId}.result-heartbeat.${lease.dispatchId}.${state.revision}` });
      state = resultHeartbeat.state;
      const feature = state.features.find(item => item.id === dispatch.featureId);
      let businessResult = transported.result;
      let hostResultReceipt = transported.receipt ?? null;
      let runtimeEvidence = transported.runtimeEvidence ?? {};
      let rejected = null;
      try {
        validateBusinessResult(businessResult, { conversationVisible: true, repair: Boolean(feature?.metadata?.repairFindingId), feature });
        validateProfileResult({ profile: api.profileRegistry.get(state.profile.id), state, feature, result: businessResult });
      }
      catch (error) {
        if (!recoverableResultCodes.has(error.code) || !['completed', 'blocked'].includes(businessResult.status) || !hostResultReceipt?.observationRequestDigest) throw error;
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
          reason: `${rejected.result.summary}. Reinspect the current source and correct the rejected result before reporting completion.`,
        }, { expectedRevision: state.revision, commandId: `${commandId}.reopen.${dispatch.dispatchId}` });
        state = reopened.state;
      } else if (shouldRetryImplementationVerificationPath({ feature, result: businessResult, state })) {
        const reopened = await api.kernel.reopenFeature(plan.project.id, activeRunId, {
          featureId: feature.id,
          reason: `The verification path is outside this Dispatch's output allowance. Inspect the check's output route and repair it only within allowedPaths, then retry the check. If no in-scope repair exists, report the exact path and blocker again. Prior evidence: ${businessResult.blocker?.summary ?? businessResult.summary}`,
        }, { expectedRevision: state.revision, commandId: `${commandId}.verification-path-reopen.${dispatch.dispatchId}` });
        state = reopened.state;
      } else if (shouldContinueImplementationProgress({ feature, result: businessResult, state,
        submission: state.submissions.find(item => item.dispatchId === dispatch.dispatchId) })) {
        const reopened = await api.kernel.reopenFeature(plan.project.id, activeRunId, {
          featureId: feature.id,
          reason: `Verified source progress was submitted, but the approved project-owned implementation remains incomplete. Continue from the current source and prior Submission within the approved plan. Do not require cross-project integration evidence or release approval for this Feature. Prior progress: ${businessResult.summary}`,
        }, { expectedRevision: state.revision, commandId: `${commandId}.implementation-progress-reopen.${dispatch.dispatchId}` });
        state = reopened.state;
      } else if (shouldContinueCollectionProgress({ feature, result: businessResult, state,
        submission: state.submissions.find(item => item.dispatchId === dispatch.dispatchId) })) {
        const reopened = await api.kernel.reopenFeature(plan.project.id, activeRunId, {
          featureId: feature.id,
          reason: `Verified Collection source progress was submitted, and in-scope work remains. Continue from the current source and prior Submission. Prior progress: ${businessResult.summary}`,
        }, { expectedRevision: state.revision, commandId: `${commandId}.collection-progress-reopen.${dispatch.dispatchId}` });
        state = reopened.state;
      }
    }
    // A running Agent may require many Host waits. Only a terminal result
    // consumes the coordination budget; heartbeats are not work rounds.
    if (!terminalLeaseObserved) continue;
    completedRounds += 1;
    rounds.push({ round: completedRounds, status: 'progressed', revision: state.revision, physicalLimit, timing: Object.fromEntries(Object.entries(timing).map(([key, value]) => [key, Math.round(value)])), elapsedMs: Math.round(performance.now() - roundStarted) });
  }
  state = await authorityStore.read(plan.project.id, activeRunId);
  if (!state.features.every(feature => feature.state === 'completed')) return { status: 'attention-required', reason: 'visible-coordinator-round-limit', planDigest: plan.planDigest, rounds, state };
  const gateRunner = new ProjectGateRunner({ harness: api, onProgress: onGateProgress });
  const featureGates = await runPendingFeatureGates({ harness: api, projectId: plan.project.id, runId: activeRunId, onProgress: onGateProgress });
  if (!featureGates.ok) return { status: 'attention-required', reason: 'feature-gates-not-passed', planDigest: plan.planDigest, rounds, gates: featureGates.results, state: featureGates.state };
  const stableGateIds = (featureGates.state.metadata?.gateRecipes ?? []).filter(recipe => recipe.scope === 'stable' && recipe.required !== false).map(recipe => recipe.id);
  if (stableGateIds.length) {
    const stable = (state.profile.config.repairOnly ? previousFreshGates(featureGates.state, 'stable', stableGateIds) : null) ?? await gateRunner.run({ projectId: plan.project.id, runId: activeRunId, scope: 'stable', forceFresh: true, gateIds: stableGateIds });
    if (!stable.results.every(gate => gate.status === 'passed')) return await retryFailedGates(stable.results) ?? { status: 'attention-required', reason: 'stable-gates-not-passed', planDigest: plan.planDigest, rounds, gates: stable, state: stable.state };
  }
  const gates = plan.stopCondition.requiredFinalGates?.length
    ? (state.profile.config.repairOnly ? previousFreshGates(state, 'final', plan.stopCondition.requiredFinalGates) : null) ?? await gateRunner.run({ projectId: plan.project.id, runId: activeRunId, scope: 'final', forceFresh: forceFreshGates, gateIds: plan.stopCondition.requiredFinalGates })
    : { results: [], state };
  state = await authorityStore.read(plan.project.id, activeRunId);
  if (!gates.results.every(gate => gate.status === 'passed')) return await retryFailedGates(gates.results) ?? { status: 'attention-required', reason: 'final-gates-not-passed', planDigest: plan.planDigest, rounds, gates, state };
  const closure = api.profileRegistry.get(state.profile.id).canClose(state);
  if (!closure.ok) return { status: 'attention-required', reason: closure.reason, planDigest: plan.planDigest, rounds, gates, state };
  const closed = await api.kernel.closeRun(plan.project.id, activeRunId, {}, { expectedRevision: state.revision, commandId: `${commandId}.close` });
  return { status: 'closed', planDigest: plan.planDigest, rounds, gates, state: closed.state, ...await completionReceipts(api, authorityStore.root, plan, closed.state) };
};

const withPlanArtifact = async (context, result) => result?.state
  ? { ...result, planApprovalArtifact: await ensurePlanApprovalArtifact(context.authorityStore.root, result.state) }
  : result;

export const executeHeadlessLifecyclePlan = async (context, api, planInput, options = {}) => withPlanArtifact(context, await runHeadlessLifecyclePlan(context, api, planInput, options));
export const executeVisibleLifecyclePlan = async (context, api, planInput, options = {}) => withPlanArtifact(context, await continueVisibleLifecyclePlan(context, api, planInput, { ...options, continuedStart: null, gateDiagnosticAttempts: 0 }));
