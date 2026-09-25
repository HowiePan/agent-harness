import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { atomicWriteJson } from '../kernel/atomic-io.mjs';
import { newId } from '../common/canonical.mjs';
import { assert } from '../common/errors.mjs';
import { assertNoLinkPath } from '../common/paths.mjs';
import { assertHarnessWritePath, harnessProjectRoot } from '../common/write-boundary.mjs';
import { captureWorkspace } from '../common/workspace-snapshot.mjs';
import { leaseHealth } from '../kernel/kernel.mjs';
import { resolveRunLineage } from './lineage.mjs';
import { sealExecutionReadinessReport } from './execution-readiness.mjs';
import { createDispatchResultContract } from '../platform/execution/result-contract.mjs';
import { assertAgentRuntimeCompatible } from '../platform/plugins/runtime/execution-policy.mjs';
import { assertFreshVisibleObservation, isVisibleHostAdapter } from '../platform/plugins/runtime/visible-host-adapter.mjs';
import { assertVisibleHostReceiptOwner } from '../platform/plugins/runtime/visible-host-bindings.mjs';
import { inspectProjectGateCapabilities } from '../platform/workflow/gates/project-gate-runner.mjs';
import { validateLifecycleCommandPlan } from './lifecycle-command-plan.mjs';
import { validateQualityReviewPolicies } from '../flow-kit/profiles/quality-loop.mjs';

export const createExecutionReadinessReport = async (context, planInput, { onGateProgress = null, probeWrite = true, ttlMs = 60000 } = {}) => {
  const {
    kernel,
    projectRegistry,
    currentReleaseIdentity,
    strictProjectIdentity,
    activeRelease,
    activeRuntimeRoot,
    resolveVisibleHostAdapter,
    authorityStore,
    lineageStore,
    extensionSet,
    pluginHost,
    executionConstraints,
    verifyPlanExecutionAuthorization,
    compileDispatchPrompt,
    controlRoot,
  } = context;
  const createdAt = kernel.now();
  const issues = error => [{ code: error.code ?? 'UNEXPECTED_ERROR', message: error.message }];
  const checks = [];
  let plan;
  let project;
  let runtimePolicy;
  let runtimeManifest;
  let existingState = null;
  let lineageResolution = null;
  const add = (id, ready, details = {}, found = []) => checks.push({ id, ready, details: structuredClone(details), issues: structuredClone(found) });
  try { plan = validateLifecycleCommandPlan(planInput); add('plan', true, { planDigest: plan.planDigest }); }
  catch (error) { add('plan', false, {}, issues(error)); }
  if (plan) {
    try {
      project = await projectRegistry.get(plan.project.id);
      assert(project.revision === plan.project.revision && project.descriptorDigest === plan.project.descriptorDigest, 'LIFECYCLE_PLAN_PROJECT_STALE', 'Lifecycle Command Plan is stale for the current Project Descriptor.');
      add('project', true, { projectId: project.id, revision: project.revision, descriptorDigest: project.descriptorDigest });
    } catch (error) { add('project', false, {}, issues(error)); }
    try {
      assert(currentReleaseIdentity.version === plan.harness.version && currentReleaseIdentity.artifactDigest === plan.harness.artifactDigest, 'LIFECYCLE_PLAN_RELEASE_STALE', 'Lifecycle Command Plan is stale for the running Harness release.');
      if (strictProjectIdentity) {
        assert(activeRelease, 'INSTALLATION_RELEASE_NOT_ACTIVATED', 'Production lifecycle execution requires an activated immutable release.');
        assert(activeRelease.release?.version === plan.harness.version && activeRelease.release?.artifactDigest === plan.harness.artifactDigest, 'ACTIVE_RELEASE_IDENTITY_MISMATCH', 'Active immutable release does not match the Lifecycle Plan.');
        assert(resolve(harnessProjectRoot()) === resolve(activeRuntimeRoot), 'ACTIVE_RUNTIME_ENTRYPOINT_MISMATCH', 'Lifecycle execution must run from the activated immutable runtime entrypoint.');
      }
      add('release', true, { active: Boolean(activeRelease), runtimeRoot: activeRuntimeRoot });
    } catch (error) { add('release', false, { active: Boolean(activeRelease), runtimeRoot: activeRuntimeRoot }, issues(error)); }
  }
  if (plan && project) {
    try {
      validateQualityReviewPolicies(plan.run.features);
      const outputs = [...new Set(plan.run.features.flatMap(feature => feature.metadata?.qualityContext?.verificationOutputPaths ?? []))];
      for (const output of outputs) assertNoLinkPath(plan.run.executionWorkspaceRoot, resolve(plan.run.executionWorkspaceRoot, output), 'quality verification output');
      add('quality-verification-paths', true, { outputs });
    } catch (error) { add('quality-verification-paths', false, {}, issues(error)); }
    const trustedAgentAdapter = resolveVisibleHostAdapter(plan.run.runtimePluginId);
    const states = await authorityStore.list(plan.project.id);
    const currentLineage = await lineageStore.read(plan.project.id, plan.logicalTaskKey);
    lineageResolution = resolveRunLineage({ plan, states, currentLineage, policy: project.policy?.recovery ?? {}, now: kernel.now, ttlMs });
    const lineageReady = lineageResolution.action !== 'block';
    add('run-lineage', lineageReady, { resolution: lineageResolution }, lineageResolution.blockers ?? []);
    try {
      existingState = lineageResolution.selectedRunId ? await authorityStore.read(plan.project.id, lineageResolution.selectedRunId, { required: false }) : null;
      const activeLeaseCount = existingState?.leases.filter(lease => lease.status === 'active').length ?? 0;
      const snapshot = await captureWorkspace(plan.run.executionWorkspaceRoot, { excluded: project.workspace.excluded ?? [] });
      const expectedSourceDigest = existingState?.sourceDigest ?? plan.run.sourceDigest;
      assert(snapshot.digest === expectedSourceDigest || activeLeaseCount > 0, 'EXECUTION_WORKSPACE_SOURCE_STALE', 'Execution workspace no longer matches the planned or authoritative source digest.', { expectedSourceDigest, actualSourceDigest: snapshot.digest });
      add('workspace-source', true, { expectedSourceDigest, actualSourceDigest: snapshot.digest, activeLeaseCount, activeLeaseMayOwnUncommittedChanges: activeLeaseCount > 0 && snapshot.digest !== expectedSourceDigest });
    } catch (error) { add('workspace-source', false, {}, issues(error)); }
    try {
      const required = project.extensions?.find(item => item.id === plan.extension.id);
      const installed = extensionSet.installed.find(item => item.id === plan.extension.id);
      assert(required && installed && required.version === plan.extension.version && required.digest === plan.extension.digest && installed.version === plan.extension.version && installed.digest === plan.extension.digest, 'PROJECT_EXTENSION_IDENTITY_MISMATCH', 'Lifecycle Plan Extension identity is not installed and bound exactly.');
      add('extension', true, { extension: plan.extension });
    } catch (error) { add('extension', false, {}, issues(error)); }
    try {
      runtimeManifest = pluginHost.get(plan.run.runtimePluginId, 'agent-runtime').manifest;
      runtimePolicy = assertAgentRuntimeCompatible({ project, manifest: runtimeManifest, action: plan.intent.action, workflowId: plan.workflow?.id, runtimePluginId: plan.run.runtimePluginId, agentExecutionMode: plan.run.agentExecutionMode });
      add('runtime', true, { id: runtimeManifest.id, version: runtimeManifest.version, mode: runtimePolicy.mode });
    } catch (error) { add('runtime', false, {}, issues(error)); }
    if (runtimeManifest) {
      const typedFeatures = plan.run.features.filter(feature => Object.keys(feature.metadata?.outputPorts ?? {}).length > 0).map(feature => feature.id);
      const compatible = !typedFeatures.length || !runtimeManifest.capabilities.includes('fixed-result-schema') || runtimeManifest.capabilities.includes('typed-output-envelope-v1');
      add('result-transport', compatible, { typedFeatures, runtimePluginId: runtimeManifest.id }, compatible ? [] : [{ code: 'RUNTIME_TYPED_OUTPUT_CONTRACT_UNSUPPORTED', message: 'The selected Runtime uses a fixed result Schema that cannot transport the workflow typed output ports.' }]);
    }
    const resultContracts = {};
    const resultContractIssues = [];
    for (const feature of plan.run.features) {
      try {
        resultContracts[feature.id] = createDispatchResultContract(feature, { conversationVisible: runtimePolicy?.mode === 'conversation-visible' }).contractDigest;
      } catch (error) {
        resultContractIssues.push({ featureId: feature.id, ...issues(error)[0] });
      }
    }
    add('result-contract', resultContractIssues.length === 0, { contractDigests: resultContracts }, resultContractIssues);
    try {
      const prompt = pluginHost.get(project.policy.promptCodecPlugin, 'codec').manifest;
      assert(prompt.capabilities.includes('agent-prompt'), 'AGENT_PROMPT_CODEC_REQUIRED', 'Project Prompt Codec does not provide agent-prompt capability.');
      add('prompt-transport', true, { id: prompt.id, version: prompt.version });
    } catch (error) { add('prompt-transport', false, {}, issues(error)); }
    if (runtimePolicy?.mode === 'headless') {
      const constraintIssues = [];
      if (executionConstraints.unattended !== 'allow-explicit') constraintIssues.push({ code: 'HEADLESS_USER_INTENT_REQUIRED', message: 'Trusted user constraints deny unattended Agent execution.' });
      if (runtimeManifest?.permissions?.includes('process.spawn') && executionConstraints.processBackedAgent !== 'allow-explicit') constraintIssues.push({ code: 'PROCESS_BACKED_AGENT_USER_DENIED', message: 'Trusted user constraints deny process-backed Agent execution.' });
      add('user-constraint', constraintIssues.length === 0, { constraints: executionConstraints }, constraintIssues);
      try {
        const authorization = await verifyPlanExecutionAuthorization({ project, plan, manifest: runtimeManifest });
        add('command-grant', true, { grantDigest: authorization.grant.grantDigest, provider: authorization.verification.provider, assertionId: authorization.verification.assertionId });
      } catch (error) { add('command-grant', false, {}, issues(error)); }
    } else {
      add('user-constraint', true, { constraints: executionConstraints, requiredFor: 'headless-only' });
      add('command-grant', true, { kind: 'interactive-command', additionalApprovalRequired: false });
    }
    const activeLeases = lineageResolution.action === 'reattach' ? existingState?.leases.filter(lease => lease.status === 'active') ?? [] : [];
    if (runtimePolicy?.hostOrchestrated) {
      const requiredCapabilities = ['inspect', 'spawn', 'wait', 'result', 'reconcile', 'confirm', 'contain'];
      const ready = isVisibleHostAdapter(trustedAgentAdapter) && requiredCapabilities.every(capability => trustedAgentAdapter.capabilities?.[capability] === true);
      add('visible-host', ready, isVisibleHostAdapter(trustedAgentAdapter) ? { provider: trustedAgentAdapter.provider, adapterVersion: trustedAgentAdapter.adapterVersion, capabilities: trustedAgentAdapter.capabilities, requiredCapabilities } : { requiredCapabilities }, ready ? [] : [{ code: 'VISIBLE_AGENT_HOST_COORDINATOR_UNAVAILABLE', message: 'Conversation-visible execution requires an injected trusted Host Adapter with inspect, spawn, wait, structured-result, reconciliation, Lease confirmation, and containment capabilities.' }]);
      if (ready && lineageReady) {
        try {
          const authorityStates = await authorityStore.listAll();
          const activeEffectIds = authorityStates.flatMap(state => {
            const expired = new Set(leaseHealth(state, Date.parse(createdAt)).filter(item => item.hardExpired).map(item => item.leaseId));
            return state.leases.filter(lease => lease.status === 'active' && !expired.has(lease.leaseId))
              .map(lease => lease.runtimeReceipt?.hostSpawnReceipt?.effectId).filter(Boolean);
          });
          const reconciliation = await trustedAgentAdapter.reconcile({
            projectId: plan.project.id,
            planDigest: plan.planDigest,
            activeEffectIds,
          });
          assert(reconciliation?.ready === true, 'VISIBLE_AGENT_HOST_RECONCILIATION_FAILED', 'Visible Host Effect reconciliation did not reach a safe state.', { issues: reconciliation?.issues ?? [] });
          assert(typeof reconciliation.provider === 'string' && typeof reconciliation.adapterVersion === 'string' && typeof reconciliation.assertionId === 'string' && typeof reconciliation.observedAt === 'string' && !Number.isNaN(Date.parse(reconciliation.observedAt)), 'VISIBLE_AGENT_HOST_CONTRACT_INVALID', 'Visible Host reconciliation must return a versioned, observable Host Contract assertion.');
          assert(reconciliation.contract?.id && /^\d+\.\d+\.\d+$/.test(reconciliation.contract?.version ?? '') && /^[a-f0-9]{64}$/.test(reconciliation.contract?.digest ?? ''), 'VISIBLE_AGENT_HOST_CONTRACT_INVALID', 'Visible Host reconciliation must bind an exact native Host Contract identity.');
          add('visible-host-contract', true, reconciliation);
        } catch (error) { add('visible-host-contract', false, {}, issues(error)); }
      } else if (!lineageReady) add('visible-host-contract', false, {}, [{ code: 'RUN_LINEAGE_BLOCKED', message: 'Visible Host reconciliation is deferred while Run lineage is blocked.' }]);
      else add('visible-host-contract', false, {}, [{ code: 'VISIBLE_AGENT_HOST_CONTRACT_UNAVAILABLE', message: 'Visible Host Contract reconciliation cannot run without the complete coordinator capability set.' }]);
    } else {
      add('visible-host', true, { required: false });
      add('visible-host-contract', true, { required: false });
    }
    if (!activeLeases.length) add('active-leases', true, { count: 0 });
    else if (!runtimePolicy?.hostOrchestrated || !isVisibleHostAdapter(trustedAgentAdapter)) {
      add('active-leases', false, { count: activeLeases.length }, [{ code: 'ACTIVE_LEASE_RESUME_UNAVAILABLE', message: 'Active Leases require their original trusted host coordinator before execution can resume.' }]);
    } else {
      const observations = [];
      const leaseIssues = [];
      for (const lease of activeLeases) {
        try {
          const dispatch = existingState.dispatches.find(item => item.dispatchId === lease.dispatchId);
          assertVisibleHostReceiptOwner(trustedAgentAdapter, lease.runtimeReceipt);
          const compiled = await compileDispatchPrompt(existingState, dispatch);
          const observation = await trustedAgentAdapter.verifyVisibleLease({ dispatch, prompt: compiled.prompt, agentId: lease.agentId, runtimeReceipt: lease.runtimeReceipt });
          assertFreshVisibleObservation(observation, { now: kernel.now, timeoutMs: lease.heartbeatTimeoutMs ?? 120000 });
          observations.push({ leaseId: lease.leaseId, dispatchId: lease.dispatchId, agentId: lease.agentId, assertionId: observation.assertionId, observedAt: observation.observedAt });
        } catch (error) { leaseIssues.push(...issues(error)); }
      }
      add('active-leases', leaseIssues.length === 0, { count: activeLeases.length, observations }, leaseIssues);
    }
    const requiredGateIds = plan.stopCondition.requiredFinalGates ?? [];
    const featureGateIds = [...new Set((plan.run.features ?? []).flatMap(feature => feature.gatePlan ?? []))].filter(id => project.gateRecipes?.some(recipe => recipe.id === id && recipe.scope === 'feature'));
    const stableGateIds = (project.gateRecipes ?? []).filter(recipe => recipe.scope === 'stable' && recipe.required !== false).map(recipe => recipe.id);
    if (requiredGateIds.length || featureGateIds.length || stableGateIds.length) {
      const reports = await Promise.all([['feature', featureGateIds], ['stable', stableGateIds], ['final', requiredGateIds]].filter(([, ids]) => ids.length).map(([scope, gateIds]) => inspectProjectGateCapabilities({ project, workspaceRoot: plan.run.executionWorkspaceRoot, scope, gateIds, onProgress: onGateProgress, pluginHost })));
      add('gates', reports.every(report => report.ready), { gates: reports.flatMap(report => report.gates) }, reports.flatMap(report => report.issues));
    } else add('gates', true, { required: false });
  }
  let writeProbe = { attempted: false, ready: false, cleaned: true };
  if (probeWrite && lineageResolution?.action !== 'block') {
    const probeRoot = assertHarnessWritePath(resolve(authorityStore.root, 'tmp', 'preflight'), 'Execution readiness write probe', controlRoot);
    const probeFile = resolve(probeRoot, `${newId('probe')}.json`);
    try {
      await mkdir(probeRoot, { recursive: true });
      await atomicWriteJson(probeFile, { protocolVersion: '1.0', kind: 'write-probe', createdAt }, { root: authorityStore.root });
      await rm(probeFile);
      writeProbe = { attempted: true, ready: true, cleaned: true };
      add('write-capability', true, writeProbe);
    } catch (error) {
      await rm(probeFile, { force: true }).catch(() => {});
      writeProbe = { attempted: true, ready: false, cleaned: true };
      add('write-capability', false, writeProbe, issues(error));
    }
  } else if (lineageResolution?.action === 'block') add('write-capability', false, writeProbe, [{ code: 'RUN_LINEAGE_BLOCKED', message: 'Execution readiness write probe is deferred while Run lineage is blocked.' }]);
  else add('write-capability', false, writeProbe, [{ code: 'WRITE_CAPABILITY_NOT_PROBED', message: 'Execution readiness requires an explicit atomic write probe.' }]);
  const executionReady = Boolean(plan && project) && checks.every(check => check.ready);
  return sealExecutionReadinessReport({
    protocolVersion: '1.0',
    kind: 'execution-readiness-report',
    planDigest: plan?.planDigest ?? '0'.repeat(64),
    lineageResolution,
    project: plan?.project ?? { id: '<invalid>', revision: 1, descriptorDigest: '0'.repeat(64) },
    release: { version: plan?.harness?.version ?? currentReleaseIdentity.version, artifactDigest: plan?.harness?.artifactDigest ?? currentReleaseIdentity.artifactDigest ?? '0'.repeat(64), active: Boolean(activeRelease), runtimeRoot: activeRuntimeRoot },
    checks,
    writeProbe,
    executionReady,
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + ttlMs).toISOString(),
  });
};
