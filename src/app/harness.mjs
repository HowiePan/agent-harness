import { resolve } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { atomicWriteJson } from '../kernel/atomic-io.mjs';
import { AuthorityStore } from '../kernel/authority-store.mjs';
import { EvidenceStore } from '../kernel/evidence-store.mjs';
import { buildDispatchPacket, HarnessKernel } from '../kernel/kernel.mjs';
import { digestJson, newId, sha256 } from '../canonical.mjs';
import { assert } from '../errors.mjs';
import { PluginHost } from '../plugins/host.mjs';
import { createConflictScheduler } from '../plugins/scheduler/conflict-scheduler.mjs';
import { createJsonCodec } from '../plugins/codec/json-codec.mjs';
import { AGENT_PROMPT_CONTRACT_VERSION, createAgentPromptCodec, REFERENCE_AGENT_PROMPT_CODEC_MANIFEST } from '../plugins/codec/agent-prompt-codec.mjs';
import { createStaticModelRouter } from '../plugins/model/static-router.mjs';
import { createAuthorityStoragePlugin } from '../plugins/storage/authority-storage.mjs';
import { featureDeliveryProfile } from '../profiles/feature-delivery.mjs';
import { ProfileRegistry } from '../profiles/registry.mjs';
import { ProjectRegistry } from '../registry/project-registry.mjs';
import { RecoveryCoordinator } from '../recovery/coordinator.mjs';
import { installExtensionPacks } from '../extensions/contract.mjs';
import { resolveCommandIntent } from '../extensions/command-contract.mjs';
import { createLifecycleCommandPlan, validateLifecycleCommandPlan } from '../lifecycle-command-plan.mjs';
import { loadReleaseIdentity } from '../release-identity.mjs';
import { captureWorkspace, diffWorkspaceSnapshots } from '../workspace-snapshot.mjs';
import { resolveProjectWorkspace } from '../workspace-identity.mjs';
import { assertHarnessWritePath, harnessControlRoot, harnessProjectRoot } from '../write-boundary.mjs';
import { RunCoordinator } from '../coordinator/run-coordinator.mjs';
import { AUTO_CONCURRENCY, AUTO_CONCURRENCY_LIMIT, resolveConcurrencyLimit } from '../concurrency.mjs';
import { ProjectGateRunner, inspectProjectGateCapabilities } from '../gates/project-gate-runner.mjs';
import { assertAgentRuntimeCompatible, assertRuntimeTransportReceipt, resolveLifecycleExecutionPolicy } from '../plugins/runtime/execution-policy.mjs';
import { assertFreshVisibleObservation, createVisibleHostAdapter, isVisibleHostAdapter } from '../plugins/runtime/visible-host-adapter.mjs';
import { validateBusinessResult } from '../result-contract.mjs';
import { sealExecutionReadinessReport, verifyExecutionReadinessReport } from '../execution-readiness.mjs';
import { readActiveRelease, resolveActiveRuntimeRoot } from '../registry/active-generation.mjs';
import { RunLineageStore, resolveRunLineage, verifyRunLineageResolution } from '../lineage.mjs';
import {
  buildExecutionGrantContext,
  createAgentRuntimeLaunchCapability,
  isExecutionAuthorizationAdapter,
  issueHeadlessExecutionGrant,
  resolveExecutionConstraints,
  verifyHeadlessExecutionGrant,
} from '../execution-authorization.mjs';

export const defaultDataRoot = (controlRoot = harnessControlRoot()) => resolve(controlRoot, '.agent-harness-data');

const manifests = Object.freeze({
  scheduler: { id: 'reference-conflict-scheduler', kind: 'scheduler', version: '1.0.0', capabilities: ['feature-dag', 'conflict-graph', 'lane-fairness'], permissions: [] },
  codec: { id: 'reference-json-codec', kind: 'codec', version: '1.0.0', capabilities: ['json', 'structured-result'], permissions: [] },
  promptCodec: REFERENCE_AGENT_PROMPT_CODEC_MANIFEST,
  model: { id: 'reference-static-model-router', kind: 'model-router', version: '1.0.0', capabilities: ['capability-route', 'risk-route'], permissions: [] },
  storage: { id: 'reference-file-storage', kind: 'storage-provider', version: '1.0.0', capabilities: ['expected-revision', 'idempotency', 'atomic-write', 'recovery'], permissions: ['state.write'] },
});

export const createHarness = async ({ controlRoot: controlRootInput, dataRoot: dataRootInput, now, id, releaseIdentity, strictProjectIdentity = true, initializeStorage = true, allowedPluginPermissions = ['state.write', 'agent.conversation', 'workspace.read', 'workspace.write', 'gate.execute', 'artifact.read'], extraProfiles = [], extensions = [], agentAdapter = null, executionAuthorizationAdapter = null } = {}) => {
  const controlRoot = harnessControlRoot(controlRootInput);
  const dataRoot = dataRootInput ?? defaultDataRoot(controlRoot);
  const controlledDataRoot = assertHarnessWritePath(dataRoot, 'Harness dataRoot', controlRoot);
  const activeRelease = await readActiveRelease(controlledDataRoot, controlRoot);
  const activeRuntimeRoot = activeRelease ? await resolveActiveRuntimeRoot(controlledDataRoot, controlRoot) : null;
  releaseIdentity ??= await loadReleaseIdentity();
  const currentReleaseIdentity = { version: releaseIdentity?.version, artifactDigest: releaseIdentity?.artifactDigest ?? null };
  assert(/^\d+\.\d+\.\d+$/.test(currentReleaseIdentity.version ?? ''), 'HARNESS_RELEASE_IDENTITY_INVALID', 'Harness release identity requires a semantic version.');
  assert(currentReleaseIdentity.artifactDigest === null || /^[a-f0-9]{64}$/.test(currentReleaseIdentity.artifactDigest), 'HARNESS_RELEASE_IDENTITY_INVALID', 'Harness artifact digest must be null or SHA-256.');
  if (strictProjectIdentity) assert(/^[a-f0-9]{64}$/.test(currentReleaseIdentity.artifactDigest ?? ''), 'HARNESS_RELEASE_ARTIFACT_REQUIRED', 'Production Harness creation requires a verified release artifact digest.');
  const authorityStore = new AuthorityStore({ root: controlledDataRoot, controlRoot, now });
  if (initializeStorage) await authorityStore.init();
  const evidenceStore = new EvidenceStore({ root: authorityStore.root, controlRoot, now });
  const lineageStore = new RunLineageStore({ root: authorityStore.root, controlRoot, now });
  const trustedAgentAdapter = agentAdapter === null || agentAdapter === undefined
    ? null
    : isVisibleHostAdapter(agentAdapter)
      ? agentAdapter
      : typeof agentAdapter.inspectVisibleAgent === 'function'
        ? createVisibleHostAdapter(agentAdapter)
        : typeof agentAdapter.verifyVisibleLease === 'function' || typeof agentAdapter.heartbeatVisibleAgent === 'function'
          ? assert(false, 'VISIBLE_AGENT_HOST_ADAPTER_REQUIRED', 'Visible Agent host callbacks must be wrapped by createVisibleHostAdapter().')
          : agentAdapter;
  const trustedExecutionAuthorizationAdapter = executionAuthorizationAdapter === null || executionAuthorizationAdapter === undefined
    ? null
    : isExecutionAuthorizationAdapter(executionAuthorizationAdapter)
      ? executionAuthorizationAdapter
      : assert(false, 'EXECUTION_AUTHORIZATION_ADAPTER_REQUIRED', 'Execution authorization callbacks must be wrapped by createExecutionAuthorizationAdapter().');
  const executionConstraints = resolveExecutionConstraints(trustedExecutionAuthorizationAdapter);
  const profileRegistry = new ProfileRegistry([featureDeliveryProfile, ...extraProfiles]);
  const pluginHost = new PluginHost({ allowedPermissions: allowedPluginPermissions });
  pluginHost.register(manifests.scheduler, createConflictScheduler({ manifest: manifests.scheduler }));
  pluginHost.register(manifests.codec, createJsonCodec({ manifest: manifests.codec }));
  pluginHost.register(manifests.promptCodec, createAgentPromptCodec({ manifest: manifests.promptCodec }));
  pluginHost.register(manifests.model, createStaticModelRouter({ manifest: manifests.model, routes: [] }));
  pluginHost.register(manifests.storage, createAuthorityStoragePlugin({ manifest: manifests.storage, store: authorityStore }));
  const projectRegistry = new ProjectRegistry({ root: authorityStore.root, controlRoot, now, strictIdentity: strictProjectIdentity });
  const extensionSet = await installExtensionPacks(extensions, {
    profileRegistry,
    pluginHost,
    factoryContext: { controlRoot, dataRoot: authorityStore.root, resolveProject: projectId => projectRegistry.get(projectId), now, agentAdapter: trustedAgentAdapter },
    requireVerifiedArtifacts: strictProjectIdentity,
  });
  const kernel = new HarnessKernel({ authorityStore, evidenceStore, profiles: profileRegistry, now, id });
  const recovery = new RecoveryCoordinator({ kernel, importers: extensionSet.recoveryImporters, projectRegistry, controlRoot });
  const extensionPacks = new Map(extensions.map(extension => [extension.id, extension]));
  const publicKernel = new Proxy(kernel, {
    get(target, property) {
      if (['bindLease', 'heartbeat'].includes(property)) return async () => assert(false, property === 'heartbeat' ? 'DIRECT_HEARTBEAT_DENIED' : 'DIRECT_LEASE_BIND_DENIED', property === 'heartbeat' ? 'Heartbeat must use the policy-aware Harness recordHeartbeat API.' : 'Lease binding must use the policy-aware Harness bindDispatch API.');
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const publicPluginHost = Object.freeze({
    get(pluginId, kind) {
      const plugin = pluginHost.get(pluginId, kind);
      if (['agent-runtime', 'gate-executor'].includes(plugin.manifest.kind)) return { manifest: plugin.manifest };
      return plugin;
    },
    async invoke(pluginId, method, ...args) {
      const plugin = pluginHost.get(pluginId);
      assert(!['agent-runtime', 'gate-executor'].includes(plugin.manifest.kind), 'DIRECT_EXECUTION_PLUGIN_INVOKE_DENIED', `${plugin.manifest.kind} ${pluginId} must be invoked through its policy-aware Harness API.`);
      return pluginHost.invoke(pluginId, method, ...args);
    },
    snapshot() { return pluginHost.snapshot(); },
  });

  const compileDispatchPrompt = async (state, dispatch) => {
    const feature = dispatch.featureSnapshot ?? state.features.find(item => item.id === dispatch.featureId);
    const packet = buildDispatchPacket(state, dispatch, feature);
    assert(digestJson(packet) === dispatch.packetDigest, 'PACKET_DIGEST_MISMATCH', 'Persisted Dispatch no longer matches its packet.');
    const binding = dispatch.execution?.prompt;
    assert(binding?.pluginId && binding?.pluginVersion && binding?.contractVersion, 'AGENT_PROMPT_BINDING_REQUIRED', 'Dispatch requires an exact Prompt Codec and contract binding.');
    const codec = pluginHost.get(binding.pluginId, 'codec');
    assert(codec.manifest.capabilities.includes('agent-prompt'), 'AGENT_PROMPT_CODEC_REQUIRED', `Codec ${binding.pluginId} does not provide agent-prompt capability.`);
    assert(codec.manifest.version === binding.pluginVersion, 'AGENT_PROMPT_CODEC_VERSION_MISMATCH', 'Installed Prompt Codec version does not match the immutable Dispatch binding.');
    const compiled = await pluginHost.invoke(binding.pluginId, 'compilePrompt', packet);
    const prompt = compiled.payload;
    assert(compiled.pluginId === binding.pluginId && compiled.pluginVersion === binding.pluginVersion, 'AGENT_PROMPT_CODEC_RECEIPT_MISMATCH', 'Prompt compilation Receipt does not match the bound Prompt Codec.');
    assert(prompt.contractVersion === binding.contractVersion && prompt.codecPluginId === binding.pluginId && prompt.codecPluginVersion === binding.pluginVersion, 'AGENT_PROMPT_CONTRACT_BINDING_MISMATCH', 'Generated Prompt does not match the Dispatch Prompt Contract binding.');
    assert(prompt.packetDigest === dispatch.packetDigest, 'AGENT_PROMPT_PACKET_DIGEST_MISMATCH', 'Generated Prompt is not bound to the immutable Dispatch packet.');
    assert(typeof prompt.text === 'string' && prompt.text.length > 0 && sha256(prompt.text) === prompt.promptDigest, 'AGENT_PROMPT_DIGEST_MISMATCH', 'Generated Prompt content does not match its digest.');
    return { packet, prompt: structuredClone(prompt) };
  };

  const grantContextFor = ({ project, intent = null, runId, runtimePluginId, runtimeVersion, executionWorkspaceRoot, sourceDigest, harnessArtifactDigest = currentReleaseIdentity.artifactDigest, extensionDigest = null, constraintDigest }) => buildExecutionGrantContext({
    project,
    intent,
    runId,
    runtimePluginId,
    runtimeVersion,
    executionWorkspaceRoot,
    sourceDigest,
    harnessArtifactDigest,
    extensionDigest,
    constraintDigest,
  });

  const verifyPlanExecutionAuthorization = async ({ project, plan, manifest }) => {
    assert(plan.run.executionConstraintDigest === executionConstraints.constraintDigest, 'EXECUTION_CONSTRAINT_STALE', 'Lifecycle Plan was created under different trusted execution constraints.');
    if (plan.run.agentExecutionMode !== 'headless') return { constraints: executionConstraints, grant: null, verification: null };
    const context = grantContextFor({ project, intent: plan.intent, runId: plan.run.runId, runtimePluginId: plan.run.runtimePluginId, runtimeVersion: manifest.version, executionWorkspaceRoot: plan.run.executionWorkspaceRoot, sourceDigest: plan.run.sourceDigest, harnessArtifactDigest: plan.harness.artifactDigest, extensionDigest: plan.extension.digest, constraintDigest: plan.run.executionConstraintDigest });
    return verifyHeadlessExecutionGrant({ adapter: trustedExecutionAuthorizationAdapter, grant: plan.run.executionGrant, context, manifest, now: kernel.now });
  };

  const verifyRunExecutionAuthorization = async ({ project, state, manifest }) => {
    const lifecycleExecution = state.metadata?.lifecycleExecution;
    const action = state.metadata?.commandIntent?.action;
    const policy = assertAgentRuntimeCompatible({ project, manifest, action, runtimePluginId: lifecycleExecution?.runtimePluginId ?? manifest.id, agentExecutionMode: lifecycleExecution?.agentExecutionMode });
    if (policy.mode !== 'headless') return { policy, constraints: executionConstraints, grant: null, verification: null };
    assert(lifecycleExecution?.executionConstraintDigest === executionConstraints.constraintDigest, 'EXECUTION_CONSTRAINT_STALE', 'Run was authorized under different trusted execution constraints.');
    const currentPolicyDigest = digestJson({ profiles: project.profiles, extensions: project.extensions ?? [], policy: project.policy ?? {}, gateRecipes: project.gateRecipes ?? [], artifactProviders: project.artifactProviders ?? [] });
    assert(currentPolicyDigest === state.policyDigest, 'RUN_EXECUTION_POLICY_STALE', 'Project execution policy changed after this Run was authorized.');
    const pinnedProject = { ...project, revision: lifecycleExecution.executionGrant?.context?.projectRevision, descriptorDigest: state.metadata?.projectDescriptorDigest };
    const context = grantContextFor({ project: pinnedProject, intent: state.metadata?.commandIntent ?? null, runId: state.runId, runtimePluginId: manifest.id, runtimeVersion: manifest.version, executionWorkspaceRoot: state.metadata?.workspace?.root ?? project.workspace.root, sourceDigest: lifecycleExecution.authorizationSourceDigest, harnessArtifactDigest: lifecycleExecution.harnessArtifactDigest, extensionDigest: lifecycleExecution.extensionDigest, constraintDigest: lifecycleExecution.executionConstraintDigest });
    const authorized = await verifyHeadlessExecutionGrant({ adapter: trustedExecutionAuthorizationAdapter, grant: lifecycleExecution.executionGrant, context, manifest, now: kernel.now });
    return { policy, ...authorized };
  };

  const api = {
    dataRoot: authorityStore.root,
    controlRoot,
    authorityStore,
    lineageStore,
    evidenceStore,
    profileRegistry,
    pluginHost: publicPluginHost,
    projectRegistry,
    kernel: publicKernel,
    recovery,
    extensionSet: { installed: extensionSet.installed, digest: extensionSet.digest },
    releaseIdentity: Object.freeze(structuredClone(currentReleaseIdentity)),

    async createExecutionReadinessReport(planInput, { onGateProgress = null, probeWrite = true, ttlMs = 60000 } = {}) {
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
          runtimePolicy = assertAgentRuntimeCompatible({ project, manifest: runtimeManifest, action: plan.intent.action, runtimePluginId: plan.run.runtimePluginId, agentExecutionMode: plan.run.agentExecutionMode });
          add('runtime', true, { id: runtimeManifest.id, version: runtimeManifest.version, mode: runtimePolicy.mode });
        } catch (error) { add('runtime', false, {}, issues(error)); }
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
          if (ready) {
            try {
              const reconciliation = await trustedAgentAdapter.reconcile({
                projectId: plan.project.id,
                planDigest: plan.planDigest,
                activeEffectIds: activeLeases.map(lease => lease.runtimeReceipt?.hostSpawnReceipt?.effectId).filter(Boolean),
              });
              assert(reconciliation?.ready === true, 'VISIBLE_AGENT_HOST_RECONCILIATION_FAILED', 'Visible Host Effect reconciliation did not reach a safe state.', { issues: reconciliation?.issues ?? [] });
              assert(typeof reconciliation.provider === 'string' && typeof reconciliation.adapterVersion === 'string' && typeof reconciliation.assertionId === 'string' && typeof reconciliation.observedAt === 'string' && !Number.isNaN(Date.parse(reconciliation.observedAt)), 'VISIBLE_AGENT_HOST_CONTRACT_INVALID', 'Visible Host reconciliation must return a versioned, observable Host Contract assertion.');
              assert(reconciliation.contract?.id && /^\d+\.\d+\.\d+$/.test(reconciliation.contract?.version ?? '') && /^[a-f0-9]{64}$/.test(reconciliation.contract?.digest ?? ''), 'VISIBLE_AGENT_HOST_CONTRACT_INVALID', 'Visible Host reconciliation must bind an exact native Host Contract identity.');
              add('visible-host-contract', true, reconciliation);
            } catch (error) { add('visible-host-contract', false, {}, issues(error)); }
          } else add('visible-host-contract', false, {}, [{ code: 'VISIBLE_AGENT_HOST_CONTRACT_UNAVAILABLE', message: 'Visible Host Contract reconciliation cannot run without the complete coordinator capability set.' }]);
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
              const compiled = await compileDispatchPrompt(existingState, dispatch);
              const observation = await trustedAgentAdapter.verifyVisibleLease({ dispatch, prompt: compiled.prompt, agentId: lease.agentId, runtimeReceipt: lease.runtimeReceipt });
              assertFreshVisibleObservation(observation, { now: kernel.now, timeoutMs: lease.heartbeatTimeoutMs ?? 120000 });
              observations.push({ leaseId: lease.leaseId, dispatchId: lease.dispatchId, agentId: lease.agentId, assertionId: observation.assertionId, observedAt: observation.observedAt });
            } catch (error) { leaseIssues.push(...issues(error)); }
          }
          add('active-leases', leaseIssues.length === 0, { count: activeLeases.length, observations }, leaseIssues);
        }
        const requiredGateIds = plan.stopCondition.requiredFinalGates ?? [];
        if (requiredGateIds.length) {
          const gateReport = await inspectProjectGateCapabilities({ project, workspaceRoot: plan.run.executionWorkspaceRoot, scope: 'final', gateIds: requiredGateIds, onProgress: onGateProgress });
          add('gates', gateReport.ready, { gates: gateReport.gates }, gateReport.issues);
        } else add('gates', true, { required: false });
      }
      let writeProbe = { attempted: false, ready: false, cleaned: true };
      if (probeWrite) {
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
      } else add('write-capability', false, writeProbe, [{ code: 'WRITE_CAPABILITY_NOT_PROBED', message: 'Execution readiness requires an explicit atomic write probe.' }]);
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
    },

    async createLifecyclePlan(input) {
      const project = await projectRegistry.get(input.projectId);
      const workspace = await resolveProjectWorkspace(project, input.executionWorkspaceRoot);
      const extensionId = input.extensionId ?? project.extensions?.find(required => extensionPacks.has(required.id))?.id;
      const extension = extensionPacks.get(extensionId);
      assert(extension, 'PROJECT_COMMAND_EXTENSION_MISSING', `No loaded Extension Pack can plan commands for Project ${project.id}.`);
      assert(extension.commandManifest, 'COMMAND_MANIFEST_MISSING', `Extension ${extension.id} does not provide a Command Manifest.`);
      assert(extension.commandManifest.profileId === input.profileId || !input.profileId, 'COMMAND_PROFILE_MISMATCH', 'Command Profile does not match the selected Extension Manifest.');
      const intent = resolveCommandIntent(extension.commandManifest, input);
      assert(project.profiles.includes(intent.profileId), 'PROJECT_PROFILE_DENIED', `Project ${project.id} does not allow Profile ${intent.profileId}.`);
      const required = project.extensions?.find(item => item.id === extension.id);
      assert(required, 'PROJECT_EXTENSION_NOT_BOUND', `Project ${project.id} does not bind Extension ${extension.id}.`);
      assert(required.version === extension.version && required.digest === extension.digest, 'PROJECT_EXTENSION_IDENTITY_MISMATCH', `Project ${project.id} does not bind the active Extension ${extension.id}.`);
      if (strictProjectIdentity) assert(project.harness?.version === currentReleaseIdentity.version && project.harness?.artifactDigest === currentReleaseIdentity.artifactDigest, 'PROJECT_HARNESS_IDENTITY_MISMATCH', `Project ${project.id} does not bind the active Harness release.`);
      const snapshot = await captureWorkspace(workspace.root, { excluded: project.workspace.excluded ?? [] });
      const executionPolicy = resolveLifecycleExecutionPolicy({ project, action: intent.action });
      const runtimeManifest = pluginHost.get(executionPolicy.runtimePluginId, 'agent-runtime').manifest;
      let executionGrant = input.executionGrant ?? null;
      let plan = createLifecycleCommandPlan({
        intent,
        project,
        extension,
        releaseIdentity: { ...currentReleaseIdentity, verified: true },
        sourceDigest: snapshot.digest,
        executionWorkspaceRoot: workspace.root,
        workspaceIdentity: workspace.identity ?? { type: 'descriptor-root', root: workspace.root },
        executionConstraintDigest: executionConstraints.constraintDigest,
        executionGrant,
        compiler: extension.operations?.createLifecyclePlan,
      });
      if (executionPolicy.mode === 'headless' && executionGrant === null && input.executionAuthorizationEvidence !== undefined && isExecutionAuthorizationAdapter(trustedExecutionAuthorizationAdapter)) {
        const context = grantContextFor({ project, intent, runId: plan.run.runId, runtimePluginId: executionPolicy.runtimePluginId, runtimeVersion: runtimeManifest.version, executionWorkspaceRoot: workspace.root, sourceDigest: snapshot.digest, extensionDigest: extension.digest, constraintDigest: executionConstraints.constraintDigest });
        executionGrant = await issueHeadlessExecutionGrant({ adapter: trustedExecutionAuthorizationAdapter, context, evidence: input.executionAuthorizationEvidence });
        plan = createLifecycleCommandPlan({ intent, project, extension, releaseIdentity: { ...currentReleaseIdentity, verified: true }, sourceDigest: snapshot.digest, executionWorkspaceRoot: workspace.root, workspaceIdentity: workspace.identity ?? { type: 'descriptor-root', root: workspace.root }, executionConstraintDigest: executionConstraints.constraintDigest, executionGrant, compiler: extension.operations?.createLifecyclePlan });
      }
      assertAgentRuntimeCompatible({ project, manifest: runtimeManifest, action: plan.intent.action, runtimePluginId: plan.run.runtimePluginId, agentExecutionMode: plan.run.agentExecutionMode });
      return plan;
    },

    async startLifecyclePlan(planInput, { commandId, preflightReport } = {}) {
      assert(commandId, 'COMMAND_ID_REQUIRED', 'Lifecycle start requires a command ID.');
      const plan = validateLifecycleCommandPlan(planInput);
      verifyExecutionReadinessReport(preflightReport, { plan, now: preflightReport?.createdAt });
      const project = await projectRegistry.get(plan.project.id);
      assert(project.revision === plan.project.revision && project.descriptorDigest === plan.project.descriptorDigest, 'LIFECYCLE_PLAN_PROJECT_STALE', 'Lifecycle Command Plan is stale for the current Project Descriptor.');
      assert(currentReleaseIdentity.artifactDigest === plan.harness.artifactDigest && currentReleaseIdentity.version === plan.harness.version, 'LIFECYCLE_PLAN_RELEASE_STALE', 'Lifecycle Command Plan is stale for the active Harness release.');
      const runtimeManifest = pluginHost.get(plan.run.runtimePluginId, 'agent-runtime').manifest;
      const runtimePolicy = assertAgentRuntimeCompatible({ project, manifest: runtimeManifest, action: plan.intent.action, runtimePluginId: plan.run.runtimePluginId, agentExecutionMode: plan.run.agentExecutionMode });
      await verifyPlanExecutionAuthorization({ project, plan, manifest: runtimeManifest });
      const observedLineage = await lineageStore.read(plan.project.id, plan.logicalTaskKey);
      const activationCommandId = `${commandId}.lineage.activate`;
      const priorActivation = observedLineage?.commands?.[activationCommandId];
      if (priorActivation) {
        assert(priorActivation.result.planDigest === plan.planDigest && priorActivation.result.resolutionDigest === preflightReport.lineageResolution.resolutionDigest, 'COMMAND_ID_REUSED', 'The lifecycle command ID was reused with different input.');
        const state = await authorityStore.read(plan.project.id, priorActivation.result.activeRunId);
        assert(state.metadata?.lifecyclePlanDigest === plan.planDigest, 'LIFECYCLE_COMMAND_RECEIPT_INVALID', 'The lifecycle command receipt points to a Run bound to another Command Plan.');
        return { status: state.status === 'closed' ? 'closed' : 'started', planDigest: plan.planDigest, plan, runtimePolicy, state, reused: true };
      }
      verifyExecutionReadinessReport(preflightReport, { plan, now: kernel.now });
      const states = await authorityStore.list(plan.project.id);
      let lineageResolution;
      try {
        lineageResolution = verifyRunLineageResolution(preflightReport.lineageResolution, { plan, states, currentLineage: observedLineage, now: kernel.now });
      } catch (error) {
        if (error.code !== 'RUN_LINEAGE_RESOLUTION_STALE') throw error;
        lineageResolution = resolveRunLineage({ plan, states, currentLineage: observedLineage, policy: project.policy?.recovery ?? {}, now: kernel.now });
      }
      assert(lineageResolution.action !== 'block', 'RUN_LINEAGE_BLOCKED', 'Lifecycle Plan has no safe automatic Run lineage action.', { blockers: lineageResolution.blockers ?? [] });
      const selectedRunId = lineageResolution.selectedRunId ?? plan.run.runId;
      const existing = await authorityStore.read(plan.project.id, selectedRunId, { required: false });
      if (runtimePolicy.hostOrchestrated && !isVisibleHostAdapter(trustedAgentAdapter)) {
        return { status: 'attention-required', reason: 'visible-agent-host-adapter-unavailable', planDigest: plan.planDigest, plan, runtimePolicy, state: existing };
      }
      let state = existing;
      if (lineageResolution.action === 'ordinary-resume' && state) {
        const resumed = await kernel.recover(plan.project.id, state.runId, { mode: 'ordinary-resume' }, { expectedRevision: state.revision, commandId: `${commandId}.lineage.resume.${lineageResolution.resolutionDigest}` });
        state = resumed.state;
      }
      if (lineageResolution.action === 'supersede-and-start') state = null;
      if (!state) {
        const started = await api.startRun({
          projectId: plan.project.id,
          runId: plan.run.runId,
          profileId: plan.run.profileId,
          features: plan.run.features,
          profileConfig: plan.run.profileConfig,
          artifactDigest: plan.run.artifactDigest,
          sourceDigest: plan.run.sourceDigest,
          executionWorkspaceRoot: plan.run.executionWorkspaceRoot,
          metadata: { ...(plan.run.metadata ?? {}), logicalTaskKey: plan.logicalTaskKey, lifecyclePlanDigest: plan.planDigest, commandIntent: plan.intent, lifecycleExecution: { runtimePluginId: plan.run.runtimePluginId, agentExecutionMode: plan.run.agentExecutionMode, executionConstraintDigest: plan.run.executionConstraintDigest, executionGrant: plan.run.executionGrant, authorizationSourceDigest: plan.run.sourceDigest, harnessArtifactDigest: plan.harness.artifactDigest, extensionDigest: plan.extension.digest }, stopCondition: plan.stopCondition },
        }, { commandId: `${commandId}.start` });
        state = started.state;
      } else if (lineageResolution.action !== 'return-closed') {
        assert(state.metadata?.lifecyclePlanDigest === plan.planDigest, 'LIFECYCLE_PLAN_RUN_CONFLICT', 'Existing Run is bound to another Command Plan.');
      }
      for (const candidate of lineageResolution.candidates) {
        if (candidate.runId === state.runId || candidate.status === 'closed' || candidate.status === 'superseded') continue;
        const current = await authorityStore.read(plan.project.id, candidate.runId);
        if (current.status === 'superseded') continue;
        await kernel.supersedeRun(plan.project.id, candidate.runId, { replacementRunId: state.runId, planDigest: plan.planDigest, reason: lineageResolution.reasonCode }, { expectedRevision: current.revision, commandId: `${commandId}.lineage.supersede.${candidate.runId}.${lineageResolution.resolutionDigest}` });
      }
      const currentLineage = await lineageStore.read(plan.project.id, plan.logicalTaskKey);
      await lineageStore.activate({ projectId: plan.project.id, logicalTaskKey: plan.logicalTaskKey, activeRunId: state.runId, planDigest: plan.planDigest, resolutionDigest: lineageResolution.resolutionDigest }, { expectedRevision: currentLineage?.revision ?? 0, commandId: activationCommandId });
      return { status: state.status === 'closed' ? 'closed' : 'started', planDigest: plan.planDigest, plan, runtimePolicy, state, lineageResolution, reused: false };
    },

    async executeLifecyclePlan(planInput, { commandId, preflightReport, maxConcurrency, maxRounds = 100, forceFreshGates = true, onGateProgress = null } = {}) {
      assert(commandId, 'COMMAND_ID_REQUIRED', 'Lifecycle execution requires a command ID.');
      const started = await api.startLifecyclePlan(planInput, { commandId, preflightReport });
      if (started.status === 'attention-required') return started;
      const { plan, runtimePolicy } = started;
      let { state } = started;
      if (state.status === 'closed') return { status: 'closed', planDigest: plan.planDigest, state };
      assert(state.status !== 'superseded', 'LIFECYCLE_PLAN_RUN_SUPERSEDED', 'Lifecycle execution cannot resume a superseded Run.');
      if (runtimePolicy.hostOrchestrated) return { status: 'attention-required', reason: 'user-visible-runtime-requires-host-orchestration', planDigest: plan.planDigest, state };
      const activeRunId = state.runId;
      const coordinator = new RunCoordinator({ harness: api });
      const execution = await coordinator.run({ projectId: plan.project.id, runId: activeRunId, runtimePluginId: plan.run.runtimePluginId, maxConcurrency, maxRounds });
      state = await authorityStore.read(plan.project.id, activeRunId);
      if (!state.features.every(feature => feature.state === 'completed')) return { status: execution.status, planDigest: plan.planDigest, execution, state };
      const gateRunner = new ProjectGateRunner({ harness: api, onProgress: onGateProgress });
      const gates = await gateRunner.run({ projectId: plan.project.id, runId: activeRunId, scope: 'final', forceFresh: forceFreshGates, gateIds: plan.stopCondition.requiredFinalGates ?? [] });
      state = await authorityStore.read(plan.project.id, activeRunId);
      if (!gates.results.every(gate => gate.status === 'passed')) return { status: 'attention-required', reason: 'final-gates-not-passed', planDigest: plan.planDigest, execution, gates, state };
      const closed = await api.kernel.closeRun(plan.project.id, activeRunId, {}, { expectedRevision: state.revision, commandId: `${commandId}.close` });
      return { status: 'closed', planDigest: plan.planDigest, execution, gates, state: closed.state };
    },

    async executeVisibleLifecyclePlan(planInput, { commandId, preflightReport, maxConcurrency, maxRounds = 100, forceFreshGates = true, onGateProgress = null } = {}) {
      assert(commandId, 'COMMAND_ID_REQUIRED', 'Visible lifecycle execution requires a command ID.');
      const started = await api.startLifecyclePlan(planInput, { commandId, preflightReport });
      if (started.status === 'attention-required' || started.status === 'closed') return started;
      const { plan, runtimePolicy } = started;
      assert(runtimePolicy.hostOrchestrated, 'VISIBLE_LIFECYCLE_RUNTIME_REQUIRED', 'Visible lifecycle execution requires a host-orchestrated Runtime.');
      assert(isVisibleHostAdapter(trustedAgentAdapter) && ['spawn', 'wait', 'result', 'reconcile', 'confirm', 'contain'].every(capability => trustedAgentAdapter.capabilities?.[capability]), 'VISIBLE_AGENT_HOST_COORDINATOR_UNAVAILABLE', 'Visible lifecycle execution requires a complete trusted Host Coordinator adapter.');
      const project = await projectRegistry.get(plan.project.id);
      const runtimeManifest = pluginHost.get(plan.run.runtimePluginId, 'agent-runtime').manifest;
      const configuredLimit = resolveConcurrencyLimit(project.policy?.maxConcurrency, project.policy?.maxConcurrency === AUTO_CONCURRENCY ? AUTO_CONCURRENCY_LIMIT : 1);
      const requestedLimit = resolveConcurrencyLimit(maxConcurrency, configuredLimit);
      const physicalLimit = runtimeManifest.capabilities.includes('workspace-shared') ? 1 : requestedLimit;
      let state = started.state;
      const activeRunId = state.runId;
      const rounds = [];
      for (let round = 1; round <= maxRounds; round += 1) {
        state = await authorityStore.read(plan.project.id, activeRunId);
        if (state.status === 'closed') return { status: 'closed', planDigest: plan.planDigest, rounds, state };
        const activeLeases = state.leases.filter(lease => lease.status === 'active');
        if (!activeLeases.length) {
          let requested = state.dispatches.filter(dispatch => dispatch.status === 'requested');
          if (!requested.length && !state.features.every(feature => feature.state === 'completed')) {
            const scheduled = await api.dispatch(plan.project.id, activeRunId, { maxConcurrency: physicalLimit, runtimePluginId: plan.run.runtimePluginId }, { expectedRevision: state.revision, commandId: `${commandId}.schedule.${state.revision}` });
            state = scheduled.state;
            requested = scheduled.result.dispatches;
          }
          for (const dispatch of requested.slice(0, physicalLimit)) {
            const compiled = await api.readDispatchPacket(plan.project.id, activeRunId, dispatch.dispatchId);
            let spawned = null;
            let runtimeReceipt = null;
            try {
              spawned = await trustedAgentAdapter.spawn({
                projectId: plan.project.id,
                runId: activeRunId,
                dispatchId: dispatch.dispatchId,
                packetDigest: dispatch.packetDigest,
                promptDigest: compiled.prompt.promptDigest,
                prompt: compiled.prompt.text,
                packet: structuredClone(compiled.packet),
              });
              assert(spawned?.agentId && spawned.visibility?.mode === 'user-visible' && spawned.visibility.surface && spawned.visibility.inspectRef, 'VISIBLE_AGENT_HOST_SPAWN_RECEIPT_INVALID', 'Host spawn must return an Agent identity and inspectable user-visible task reference.');
              state = await authorityStore.read(plan.project.id, activeRunId);
              runtimeReceipt = {
                runtimePluginId: plan.run.runtimePluginId,
                agentId: spawned.agentId,
                dispatchId: dispatch.dispatchId,
                packetDigest: dispatch.packetDigest,
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
          rounds.push({ round, status: 'attention-required', reason: state.status });
          return { status: 'attention-required', reason: state.status, planDigest: plan.planDigest, rounds, state };
        }
        for (const lease of leases) {
          const dispatch = state.dispatches.find(item => item.dispatchId === lease.dispatchId);
          const waited = await trustedAgentAdapter.wait({ agentId: lease.agentId, dispatchId: lease.dispatchId, visibility: structuredClone(lease.runtimeReceipt.visibility), runtimeReceipt: structuredClone(lease.runtimeReceipt) });
          state = await authorityStore.read(plan.project.id, activeRunId);
          const heartbeat = await api.recordHeartbeat(plan.project.id, activeRunId, { leaseId: lease.leaseId, dispatchId: lease.dispatchId, agentId: lease.agentId, progress: waited?.progress ?? waited?.status ?? 'completed' }, { expectedRevision: state.revision, commandId: `${commandId}.heartbeat.${lease.dispatchId}.${state.revision}` });
          state = heartbeat.state;
          if (!['completed', 'failed', 'blocked'].includes(waited?.status)) continue;
          const transported = await trustedAgentAdapter.result({ agentId: lease.agentId, dispatchId: lease.dispatchId, visibility: structuredClone(lease.runtimeReceipt.visibility), runtimeReceipt: structuredClone(lease.runtimeReceipt) });
          assert(transported?.result, 'VISIBLE_AGENT_STRUCTURED_RESULT_REQUIRED', 'Host result transport must return a structured Agent result.');
          const submitted = await api.recordResult(plan.project.id, activeRunId, dispatch.dispatchId, transported.result, { commandId: `${commandId}.submit.${dispatch.dispatchId}`, runtimeEvidence: { ...(transported.runtimeEvidence ?? {}), hostWaitReceipt: waited?.receipt ?? null, hostResultReceipt: transported.receipt ?? null } });
          state = submitted.state;
        }
        rounds.push({ round, status: 'progressed', revision: state.revision, physicalLimit });
      }
      state = await authorityStore.read(plan.project.id, activeRunId);
      if (!state.features.every(feature => feature.state === 'completed')) return { status: 'attention-required', reason: 'visible-coordinator-round-limit', planDigest: plan.planDigest, rounds, state };
      const gateRunner = new ProjectGateRunner({ harness: api, onProgress: onGateProgress });
      const gates = plan.stopCondition.requiredFinalGates?.length
        ? await gateRunner.run({ projectId: plan.project.id, runId: activeRunId, scope: 'final', forceFresh: forceFreshGates, gateIds: plan.stopCondition.requiredFinalGates })
        : { results: [], state };
      state = await authorityStore.read(plan.project.id, activeRunId);
      if (!gates.results.every(gate => gate.status === 'passed')) return { status: 'attention-required', reason: 'final-gates-not-passed', planDigest: plan.planDigest, rounds, gates, state };
      const closure = api.profileRegistry.get(state.profile.id).canClose(state);
      if (!closure.ok) return { status: 'attention-required', reason: closure.reason, planDigest: plan.planDigest, rounds, gates, state };
      const closed = await api.kernel.closeRun(plan.project.id, activeRunId, {}, { expectedRevision: state.revision, commandId: `${commandId}.close` });
      return { status: 'closed', planDigest: plan.planDigest, rounds, gates, state: closed.state };
    },

    registerPlugin(manifest, instance) { return pluginHost.register(manifest, instance); },

    getRuntimeManifest(runtimePluginId) {
      return pluginHost.get(runtimePluginId, 'agent-runtime').manifest;
    },

    runtimeSupports(runtimePluginId, method) {
      const runtime = pluginHost.get(runtimePluginId, 'agent-runtime');
      return typeof runtime.instance[method] === 'function';
    },

    async invokeBoundRuntime(projectId, runId, dispatchId, method, input = {}) {
      assert(['wait', 'integrate', 'discard', 'cleanup', 'heartbeat', 'interrupt', 'send'].includes(method), 'RUNTIME_CONTROL_METHOD_DENIED', `Unsupported managed Runtime operation: ${method}`);
      const [project, state] = await Promise.all([projectRegistry.get(projectId), authorityStore.read(projectId, runId)]);
      const dispatch = state.dispatches.find(item => item.dispatchId === dispatchId);
      const lease = state.leases.find(item => item.dispatchId === dispatchId && item.status === 'active');
      assert(dispatch && lease, 'ACTIVE_LEASE_REQUIRED', `Dispatch does not have an active managed Lease: ${dispatchId}`);
      const manifest = pluginHost.get(dispatch.runtimePluginId, 'agent-runtime').manifest;
      const action = state.metadata?.commandIntent?.action;
      const runtimePolicy = assertAgentRuntimeCompatible({ project, manifest, action, runtimePluginId: dispatch.runtimePluginId, agentExecutionMode: dispatch.execution?.runtime?.mode });
      assert(runtimePolicy.mode === 'headless', 'VISIBLE_AGENT_HOST_REQUIRED', 'Conversation-visible Agents must be controlled by the interactive host, not through Runtime plugin invocation.');
      if (!['interrupt', 'cleanup', 'discard'].includes(method)) await verifyRunExecutionAuthorization({ project, state, manifest });
      return pluginHost.invoke(dispatch.runtimePluginId, method, { agentId: lease.agentId, ...structuredClone(input) });
    },

    async assertRunExecutionAuthorized(projectId, runId) {
      const [project, state] = await Promise.all([projectRegistry.get(projectId), authorityStore.read(projectId, runId)]);
      const runtimePluginId = state.metadata?.lifecycleExecution?.runtimePluginId ?? resolveLifecycleExecutionPolicy({ project, action: state.metadata?.commandIntent?.action }).runtimePluginId;
      const manifest = pluginHost.get(runtimePluginId, 'agent-runtime').manifest;
      return verifyRunExecutionAuthorization({ project, state, manifest });
    },

    async startRun(input, command) {
      const project = await projectRegistry.get(input.projectId);
      const workspace = await resolveProjectWorkspace(project, input.executionWorkspaceRoot);
      if (strictProjectIdentity) assert(project.harness && /^[a-f0-9]{64}$/.test(project.harness.artifactDigest ?? ''), 'PROJECT_HARNESS_IDENTITY_REQUIRED', `Project ${project.id} does not bind an exact Harness artifact.`);
      if (project.harness) {
        assert(project.harness.version === currentReleaseIdentity.version, 'PROJECT_HARNESS_VERSION_MISMATCH', `Project ${project.id} requires Harness ${project.harness.version}.`, { installedVersion: currentReleaseIdentity.version });
        if (project.harness.artifactDigest) assert(project.harness.artifactDigest === currentReleaseIdentity.artifactDigest, 'PROJECT_HARNESS_DIGEST_MISMATCH', `Project ${project.id} requires a different Harness artifact.`, { installedArtifactDigest: currentReleaseIdentity.artifactDigest });
      }
      for (const required of project.extensions ?? []) {
        if (strictProjectIdentity) assert(/^[a-f0-9]{64}$/.test(required.digest ?? ''), 'PROJECT_EXTENSION_DIGEST_REQUIRED', `Project ${project.id} does not bind an exact ${required.id} artifact.`);
        const installed = extensionSet.installed.find(extension => extension.id === required.id);
        assert(installed, 'PROJECT_EXTENSION_MISSING', `Project ${project.id} requires Extension Pack ${required.id}.`);
        assert(installed.version === required.version, 'PROJECT_EXTENSION_VERSION_MISMATCH', `Project ${project.id} requires Extension Pack ${required.id}@${required.version}.`, { installedVersion: installed.version });
        if (required.digest) assert(installed.digest === required.digest, 'PROJECT_EXTENSION_DIGEST_MISMATCH', `Project ${project.id} requires a different ${required.id} artifact.`, { expectedDigest: required.digest, installedDigest: installed.digest ?? null });
      }
      assert(profileRegistry.get(input.profileId), 'PROFILE_NOT_INSTALLED', `Profile is not installed: ${input.profileId}`);
      assert(project.profiles.includes(input.profileId), 'PROJECT_PROFILE_DENIED', `Project ${project.id} does not allow Profile ${input.profileId}.`);
      const requiredFinalGates = (project.gateRecipes ?? []).filter(recipe => recipe.scope === 'final' && recipe.required !== false).map(recipe => recipe.id);
      const profileConfig = {
        ...(project.policy?.profileConfigs?.[input.profileId] ?? {}),
        ...(input.profileConfig ?? {}),
        ...(input.profileConfig?.requiredFinalGates === undefined ? { requiredFinalGates } : {}),
      };
      const snapshot = input.sourceDigest ? null : await captureWorkspace(workspace.root, { excluded: project.workspace.excluded ?? [] });
      const pluginSet = pluginHost.snapshot();
      const installedCompositionDigest = digestJson({ plugins: pluginSet.manifests, extensions: extensionSet.installed });
      const policyDigest = input.policyDigest ?? digestJson({ profiles: project.profiles, extensions: project.extensions ?? [], policy: project.policy ?? {}, gateRecipes: project.gateRecipes ?? [], artifactProviders: project.artifactProviders ?? [] });
      const commandIntent = input.metadata?.commandIntent ?? null;
      const commandAction = commandIntent?.action;
      const executionPolicy = resolveLifecycleExecutionPolicy({ project, action: commandAction });
      if (input.metadata?.lifecycleExecution) {
        assert(input.metadata.lifecycleExecution.runtimePluginId === executionPolicy.runtimePluginId && input.metadata.lifecycleExecution.agentExecutionMode === executionPolicy.mode, 'RUN_EXECUTION_POLICY_MISMATCH', 'Run execution metadata does not match the current Project action execution policy.');
      }
      const executionConstraintDigest = input.metadata?.lifecycleExecution?.executionConstraintDigest ?? input.executionConstraintDigest ?? executionConstraints.constraintDigest;
      assert(executionConstraintDigest === executionConstraints.constraintDigest, 'EXECUTION_CONSTRAINT_STALE', 'Run creation uses stale or mismatched trusted execution constraints.');
      const authorizationSourceDigest = input.metadata?.lifecycleExecution?.authorizationSourceDigest ?? input.sourceDigest ?? snapshot.digest;
      let executionGrant = input.metadata?.lifecycleExecution?.executionGrant ?? input.executionGrant ?? null;
      const lifecycleExecution = { runtimePluginId: executionPolicy.runtimePluginId, agentExecutionMode: executionPolicy.mode, executionConstraintDigest, executionGrant, authorizationSourceDigest, harnessArtifactDigest: input.metadata?.lifecycleExecution?.harnessArtifactDigest ?? currentReleaseIdentity.artifactDigest, extensionDigest: input.metadata?.lifecycleExecution?.extensionDigest ?? null };
      if (executionPolicy.mode === 'headless') {
        const runtimeManifest = pluginHost.get(executionPolicy.runtimePluginId, 'agent-runtime').manifest;
        const context = grantContextFor({ project, intent: commandIntent, runId: input.runId, runtimePluginId: executionPolicy.runtimePluginId, runtimeVersion: runtimeManifest.version, executionWorkspaceRoot: workspace.root, sourceDigest: authorizationSourceDigest, harnessArtifactDigest: lifecycleExecution.harnessArtifactDigest, extensionDigest: lifecycleExecution.extensionDigest, constraintDigest: executionConstraintDigest });
        if (executionGrant === null && input.executionAuthorizationEvidence !== undefined && isExecutionAuthorizationAdapter(trustedExecutionAuthorizationAdapter)) {
          executionGrant = await issueHeadlessExecutionGrant({ adapter: trustedExecutionAuthorizationAdapter, context, evidence: input.executionAuthorizationEvidence });
          lifecycleExecution.executionGrant = executionGrant;
        }
        await verifyHeadlessExecutionGrant({ adapter: trustedExecutionAuthorizationAdapter, grant: executionGrant, context, manifest: runtimeManifest, now: kernel.now });
      }
      return kernel.startRun({ ...input, profileConfig, policyDigest, sourceDigest: input.sourceDigest ?? snapshot.digest, pluginSetDigest: input.pluginSetDigest ?? installedCompositionDigest, metadata: { ...input.metadata, ...(lifecycleExecution ? { lifecycleExecution } : {}), workspace: structuredClone(workspace), projectDescriptorDigest: project.descriptorDigest, extensionSetDigest: extensionSet.digest } }, command);
    },

    async dispatch(projectId, runId, input, command) {
      const state = await authorityStore.read(projectId, runId);
      if (state.metadata?.logicalTaskKey) await lineageStore.assertActive(projectId, state.metadata.logicalTaskKey, runId);
      assert(state.revision === command.expectedRevision, 'REVISION_CONFLICT', 'Authority revision changed before scheduling.', { expected: command.expectedRevision, actual: state.revision });
      const project = await projectRegistry.get(projectId);
      const workspaceRoot = state.metadata?.workspace?.root ?? project.workspace.root;
      const action = state.metadata?.commandIntent?.action;
      const selectedPolicy = resolveLifecycleExecutionPolicy({ project, action });
      const runtimePluginId = input.runtimePluginId ?? state.metadata?.lifecycleExecution?.runtimePluginId ?? selectedPolicy.runtimePluginId;
      assert(runtimePluginId, 'DEFAULT_RUNTIME_REQUIRED', `Project ${projectId} requires an explicit default Runtime.`);
      let runtimeManifest = null;
      let runtimePolicy = null;
      if (runtimePluginId) {
        assert((project.policy?.runtimePlugins ?? [runtimePluginId]).includes(runtimePluginId), 'PROJECT_RUNTIME_DENIED', `Runtime ${runtimePluginId} is not allowed by Project ${projectId}.`);
        runtimeManifest = pluginHost.get(runtimePluginId, 'agent-runtime').manifest;
        runtimePolicy = assertAgentRuntimeCompatible({ project, manifest: runtimeManifest, action, runtimePluginId, agentExecutionMode: state.metadata?.lifecycleExecution?.agentExecutionMode ?? selectedPolicy.mode });
        if (runtimePolicy.mode === 'headless') await verifyRunExecutionAuthorization({ project, state, manifest: runtimeManifest });
      }
      const promptCodecPluginId = project.policy?.promptCodecPlugin ?? null;
      assert(promptCodecPluginId, 'PROJECT_PROMPT_CODEC_REQUIRED', `Project ${projectId} requires an explicit Prompt Codec.`);
      assert(input.promptCodecPluginId === undefined || input.promptCodecPluginId === promptCodecPluginId, 'PROJECT_PROMPT_CODEC_OVERRIDE_DENIED', 'Dispatch cannot override the Prompt Codec pinned by the Project Descriptor.');
      const promptCodecManifest = pluginHost.get(promptCodecPluginId, 'codec').manifest;
      assert(promptCodecManifest.capabilities.includes('agent-prompt'), 'AGENT_PROMPT_CODEC_REQUIRED', `Codec ${promptCodecPluginId} does not provide agent-prompt capability.`);
      const promptBinding = { pluginId: promptCodecManifest.id, pluginVersion: promptCodecManifest.version, contractVersion: AGENT_PROMPT_CONTRACT_VERSION };
      const configuredLimit = resolveConcurrencyLimit(project.policy?.maxConcurrency, project.policy?.maxConcurrency === AUTO_CONCURRENCY ? AUTO_CONCURRENCY_LIMIT : 1);
      const requestedLimit = resolveConcurrencyLimit(input.maxConcurrency, configuredLimit);
      const schedulingLimit = runtimeManifest?.capabilities.includes('workspace-shared') ? 1 : requestedLimit;
      const snapshot = await captureWorkspace(workspaceRoot, { excluded: project.workspace.excluded ?? [] });
      assert(snapshot.digest === state.sourceDigest, 'WORKSPACE_SOURCE_DRIFT', 'Workspace changed outside a committed Feature result.', { authoritySourceDigest: state.sourceDigest, workspaceSourceDigest: snapshot.digest });
      const snapshotEvidence = await evidenceStore.put(snapshot, { mediaType: 'application/json', projectId, runId, epoch: state.epoch, generation: state.generation, sourceDigest: state.sourceDigest, artifactDigest: state.artifactDigest, policyDigest: state.policyDigest, pluginSetDigest: state.pluginSetDigest, labels: ['workspace-snapshot'] });
      const visibleHeartbeatTimeoutMs = Number(project.policy?.visibleHeartbeatTimeoutMs ?? 120000);
      if (runtimePolicy.mode === 'conversation-visible') assert(Number.isFinite(visibleHeartbeatTimeoutMs) && visibleHeartbeatTimeoutMs > 0, 'VISIBLE_AGENT_HEARTBEAT_TIMEOUT_INVALID', 'Visible Agent heartbeat timeout must be a positive number of milliseconds.');
      const scheduledInput = { ...input, maxConcurrency: schedulingLimit, runtimePluginId, runtimeRequirements: { mode: runtimePolicy.mode, userVisible: runtimePolicy.userVisible, hostOrchestrated: runtimePolicy.hostOrchestrated, ...(runtimePolicy.mode === 'conversation-visible' ? { heartbeatTimeoutMs: visibleHeartbeatTimeoutMs } : {}) }, sourceSnapshotRef: snapshotEvidence.ref };
      if (input.candidateFeatureIds) {
        const executionByFeatureId = Object.fromEntries(input.candidateFeatureIds.map(featureId => [featureId, { prompt: structuredClone(promptBinding) }]));
        return kernel.schedule(projectId, runId, { ...scheduledInput, executionByFeatureId }, command);
      }
      const activeFeatureIds = [...new Set([...state.leases.filter(lease => ['requested', 'active'].includes(lease.status)).map(lease => lease.featureId), ...state.dispatches.filter(dispatch => ['requested', 'assigned'].includes(dispatch.status)).map(dispatch => dispatch.featureId)])];
      const strategy = await pluginHost.invoke(input.schedulerPluginId ?? manifests.scheduler.id, 'select', { revision: state.revision, features: state.features, activeFeatureIds, limit: schedulingLimit, deniedFeatureIds: [] });
      const executionByFeatureId = {};
      const modelRouterPluginId = input.modelRouterPluginId ?? project.policy?.modelRouterPlugin ?? null;
      const toolBrokerPluginId = input.toolBrokerPluginId ?? project.policy?.toolBrokerPlugin ?? null;
      if (toolBrokerPluginId) pluginHost.get(toolBrokerPluginId, 'tool-broker');
      for (const featureId of strategy.payload.featureIds) {
        const feature = state.features.find(item => item.id === featureId);
        const execution = { prompt: structuredClone(promptBinding), ...(runtimePolicy ? { runtime: { mode: runtimePolicy.mode, userVisible: runtimePolicy.userVisible, hostOrchestrated: runtimePolicy.hostOrchestrated } } : {}) };
        if (modelRouterPluginId) {
          const request = { featureId, role: feature.ownerRole, capabilities: feature.metadata.requiredCapabilities ?? [], risk: Number(feature.metadata.risk ?? 0) };
          const route = await pluginHost.invoke(modelRouterPluginId, 'route', { ...request, requestDigest: digestJson(request) });
          execution.modelRoute = { pluginId: route.pluginId, pluginVersion: route.pluginVersion, ...structuredClone(route.payload) };
        }
        if (toolBrokerPluginId) execution.toolBroker = { pluginId: toolBrokerPluginId };
        executionByFeatureId[featureId] = execution;
      }
      return kernel.schedule(projectId, runId, { ...scheduledInput, candidateFeatureIds: strategy.payload.featureIds, executionByFeatureId, schedulerReceipt: { pluginId: strategy.pluginId, pluginVersion: strategy.pluginVersion } }, command);
    },

    async spawnDispatch(projectId, runId, dispatchId, runtimePluginId, commandId) {
      let state = await authorityStore.read(projectId, runId);
      const project = await projectRegistry.get(projectId);
      const dispatch = state.dispatches.find(item => item.dispatchId === dispatchId);
      assert(dispatch?.status === 'requested', 'DISPATCH_NOT_SPAWNABLE', `Dispatch is not awaiting a Runtime: ${dispatchId}`);
      assert(dispatch.runtimePluginId === runtimePluginId, 'DISPATCH_RUNTIME_MISMATCH', `Dispatch ${dispatchId} is bound to Runtime ${dispatch.runtimePluginId}, not ${runtimePluginId}.`);
      const manifest = pluginHost.get(runtimePluginId, 'agent-runtime').manifest;
      const runtimePolicy = assertAgentRuntimeCompatible({ project, manifest, action: state.metadata?.commandIntent?.action, runtimePluginId, agentExecutionMode: dispatch.execution?.runtime?.mode });
      assert(!runtimePolicy.hostOrchestrated, 'VISIBLE_AGENT_HOST_REQUIRED', `Runtime ${runtimePluginId} must be started by the interactive host as a visible child Agent.`);
      const authorization = await verifyRunExecutionAuthorization({ project, state, manifest });
      const { packet, prompt } = await compileDispatchPrompt(state, dispatch);
      const launchCapability = createAgentRuntimeLaunchCapability({ grantDigest: authorization.grant.grantDigest, runtimePluginId, dispatchId, packetDigest: dispatch.packetDigest });
      const runtime = await pluginHost.invoke(runtimePluginId, 'spawn', packet, { prompt, launchCapability, executionGrantDigest: authorization.grant.grantDigest, packetDigest: dispatch.packetDigest });
      const payload = runtime.payload;
      const bound = await api.bindDispatch(projectId, runId, { dispatchId, agentId: payload.agentId, runtimeReceipt: payload.transportReceipt }, { expectedRevision: state.revision, commandId });
      return { packet, prompt, runtimeReceipt: runtime, lease: bound.result.lease, state: bound.state };
    },

    async readDispatchPacket(projectId, runId, dispatchId) {
      const state = await authorityStore.read(projectId, runId);
      if (state.metadata?.logicalTaskKey) await lineageStore.assertActive(projectId, state.metadata.logicalTaskKey, runId);
      const dispatch = state.dispatches.find(item => item.dispatchId === dispatchId);
      assert(dispatch?.status === 'requested', 'DISPATCH_NOT_READABLE', `Dispatch is not awaiting a visible Agent: ${dispatchId}`);
      const { packet, prompt } = await compileDispatchPrompt(state, dispatch);
      return { dispatch: structuredClone(dispatch), packet, prompt };
    },

    async bindDispatch(projectId, runId, input, command) {
      const state = await authorityStore.read(projectId, runId);
      if (state.metadata?.logicalTaskKey) await lineageStore.assertActive(projectId, state.metadata.logicalTaskKey, runId);
      assert(state.revision === command.expectedRevision, 'REVISION_CONFLICT', 'Authority revision changed before Runtime binding.', { expected: command.expectedRevision, actual: state.revision });
      const dispatch = state.dispatches.find(item => item.dispatchId === input.dispatchId);
      assert(dispatch?.status === 'requested', 'DISPATCH_NOT_BINDABLE', `Dispatch is not awaiting a Runtime: ${input.dispatchId}`);
      const project = await projectRegistry.get(projectId);
      const manifest = pluginHost.get(dispatch.runtimePluginId, 'agent-runtime').manifest;
      const runtimePolicy = assertRuntimeTransportReceipt({ project, manifest, receipt: input.runtimeReceipt, action: state.metadata?.commandIntent?.action, runtimePluginId: dispatch.runtimePluginId, agentExecutionMode: dispatch.execution?.runtime?.mode });
      let runtimeReceipt = structuredClone(input.runtimeReceipt);
      if (runtimePolicy.mode === 'conversation-visible') {
        const { prompt } = await compileDispatchPrompt(state, dispatch);
        assert(runtimeReceipt.agentId === input.agentId, 'RUNTIME_RECEIPT_AGENT_MISMATCH', 'Runtime Receipt Agent identity does not match the requested Lease binding.');
        assert(runtimeReceipt.dispatchId === dispatch.dispatchId, 'RUNTIME_RECEIPT_DISPATCH_MISMATCH', 'Runtime Receipt Dispatch identity does not match the managed Dispatch.');
        assert(runtimeReceipt.packetDigest === dispatch.packetDigest, 'PACKET_DIGEST_MISMATCH', 'Runtime Receipt does not match the immutable Dispatch packet.');
        assert(runtimeReceipt.prompt?.codecPluginId === prompt.codecPluginId && runtimeReceipt.prompt?.codecPluginVersion === prompt.codecPluginVersion && runtimeReceipt.prompt?.contractVersion === prompt.contractVersion, 'AGENT_PROMPT_RECEIPT_IDENTITY_MISMATCH', 'Visible Runtime Receipt does not match the generated Prompt Contract identity.');
        assert(runtimeReceipt.prompt?.packetDigest === prompt.packetDigest && runtimeReceipt.prompt?.promptDigest === prompt.promptDigest, 'AGENT_PROMPT_RECEIPT_DIGEST_MISMATCH', 'Visible Runtime Receipt is not bound to the exact generated Prompt and Dispatch packet.');
        assert(typeof trustedAgentAdapter?.verifyVisibleLease === 'function', 'VISIBLE_AGENT_HOST_ATTESTOR_REQUIRED', 'Conversation-visible Lease binding requires a trusted host adapter that can verify the visible child Agent.');
        const attestation = await trustedAgentAdapter.verifyVisibleLease({ project: structuredClone(project), dispatch: structuredClone(dispatch), prompt: structuredClone(prompt), agentId: input.agentId, runtimeReceipt: structuredClone(runtimeReceipt) });
        assert(attestation?.verified === true, 'VISIBLE_AGENT_HOST_ATTESTATION_REJECTED', 'The interactive host did not verify the visible child Agent Lease.');
        assert(typeof attestation.provider === 'string' && attestation.provider.length > 0 && typeof attestation.assertionId === 'string' && attestation.assertionId.length > 0 && typeof attestation.observedAt === 'string' && !Number.isNaN(Date.parse(attestation.observedAt)), 'VISIBLE_AGENT_HOST_ATTESTATION_INVALID', 'Trusted host attestation must include provider, assertion ID, and observation timestamp.');
        assert(attestation.agentId === input.agentId && attestation.dispatchId === dispatch.dispatchId && attestation.packetDigest === dispatch.packetDigest && attestation.promptDigest === prompt.promptDigest, 'VISIBLE_AGENT_HOST_ATTESTATION_MISMATCH', 'Host attestation is not bound to this Agent, Dispatch, packet, and generated Prompt.');
        assertFreshVisibleObservation(attestation, { now: kernel.now, timeoutMs: Number(project.policy?.visibleHeartbeatTimeoutMs ?? 120000) });
        runtimeReceipt.hostAttestation = { ...structuredClone(attestation), verified: true };
      }
      const bound = await kernel.bindLease(projectId, runId, { dispatchId: dispatch.dispatchId, agentId: input.agentId, packetDigest: dispatch.packetDigest, runtimeReceipt }, command);
      if (runtimePolicy.mode === 'conversation-visible' && trustedAgentAdapter?.capabilities?.confirm === true) {
        try {
          await trustedAgentAdapter.confirm({
            projectId,
            runId,
            dispatchId: dispatch.dispatchId,
            packetDigest: dispatch.packetDigest,
            promptDigest: runtimeReceipt.prompt.promptDigest,
            agentId: input.agentId,
            runtimeReceipt: structuredClone(bound.result.lease.runtimeReceipt),
          });
        } catch (error) {
          error.details = { ...(error.details ?? {}), leaseBound: true, leaseId: bound.result.lease.leaseId, dispatchId: dispatch.dispatchId };
          throw error;
        }
      }
      return bound;
    },

    async recordHeartbeat(projectId, runId, input, command) {
      const state = await authorityStore.read(projectId, runId);
      if (state.metadata?.logicalTaskKey) await lineageStore.assertActive(projectId, state.metadata.logicalTaskKey, runId);
      assert(state.revision === command.expectedRevision, 'REVISION_CONFLICT', 'Authority revision changed before Runtime heartbeat.', { expected: command.expectedRevision, actual: state.revision });
      const dispatch = state.dispatches.find(item => item.dispatchId === input.dispatchId);
      const lease = state.leases.find(item => item.leaseId === input.leaseId && item.status === 'active');
      assert(dispatch && lease && lease.dispatchId === dispatch.dispatchId, 'ACTIVE_LEASE_REQUIRED', 'Heartbeat requires an active Dispatch Lease.');
      assert(input.agentId === lease.agentId, 'LEASE_IDENTITY_MISMATCH', 'Heartbeat identity does not match the active Lease.');
      const project = await projectRegistry.get(projectId);
      if (dispatch.execution?.runtime?.mode === 'conversation-visible') {
        const { prompt } = await compileDispatchPrompt(state, dispatch);
        assert(typeof trustedAgentAdapter?.heartbeatVisibleAgent === 'function', 'VISIBLE_AGENT_HOST_HEARTBEAT_REQUIRED', 'Conversation-visible heartbeat requires a trusted host observation adapter.');
        const observation = await trustedAgentAdapter.heartbeatVisibleAgent({ project: structuredClone(project), dispatch: structuredClone(dispatch), prompt: structuredClone(prompt), agentId: input.agentId, runtimeReceipt: structuredClone(lease.runtimeReceipt) });
        assert(observation?.verified === true, 'VISIBLE_AGENT_HOST_HEARTBEAT_REJECTED', 'The interactive host did not verify the visible Agent heartbeat.');
        assert(observation.agentId === input.agentId && observation.dispatchId === dispatch.dispatchId && observation.packetDigest === dispatch.packetDigest && observation.promptDigest === prompt.promptDigest, 'VISIBLE_AGENT_HOST_HEARTBEAT_MISMATCH', 'Visible Agent heartbeat is not bound to this Agent, Dispatch, packet, and Prompt.');
        assertFreshVisibleObservation(observation, { now: kernel.now, timeoutMs: Number(project.policy?.visibleHeartbeatTimeoutMs ?? 120000) });
      }
      return kernel.heartbeat(projectId, runId, { leaseId: input.leaseId, agentId: input.agentId, progress: input.progress ?? null }, command);
    },

    async recordResult(projectId, runId, dispatchId, result, { commandId, evidenceMetadata = {}, runtimeEvidence = null }) {
      const state = await authorityStore.read(projectId, runId);
      if (state.metadata?.logicalTaskKey) await lineageStore.assertActive(projectId, state.metadata.logicalTaskKey, runId);
      const dispatch = state.dispatches.find(item => item.dispatchId === dispatchId);
      const lease = state.leases.find(item => item.dispatchId === dispatchId && item.status === 'active');
      assert(dispatch && lease, 'ACTIVE_LEASE_REQUIRED', `Dispatch does not have an active Lease: ${dispatchId}`);
      const conversationVisible = dispatch.execution?.runtime?.mode === 'conversation-visible';
      const feature = state.features.find(item => item.id === dispatch.featureId);
      const validatedResult = validateBusinessResult(result, { conversationVisible, repair: Boolean(feature?.metadata?.repairFindingId) });
      if (feature?.metadata?.repairFindingId && validatedResult.status === 'completed') {
        assert(Array.isArray(runtimeEvidence?.verificationReceipts) && runtimeEvidence.verificationReceipts.length > 0, 'REPAIR_VERIFICATION_RECEIPT_REQUIRED', 'A completed repair requires at least one host-preserved verification Receipt.');
      }
      if (conversationVisible) {
        assert(Number(lease.heartbeatCount ?? 0) > 0, 'VISIBLE_AGENT_HEARTBEAT_REQUIRED', 'Conversation-visible Agent result requires at least one recorded host heartbeat.');
        const timeoutMs = Number(lease.heartbeatTimeoutMs ?? 120000);
        assert(Date.parse(kernel.now()) - Date.parse(lease.lastHeartbeatAt) < timeoutMs, 'VISIBLE_AGENT_HEARTBEAT_EXPIRED', 'Conversation-visible Agent heartbeat expired before result recording.');
      }
      const project = await projectRegistry.get(projectId);
      const workspaceRoot = state.metadata?.workspace?.root ?? project.workspace.root;
      const sourceSnapshotEvidence = await evidenceStore.read(dispatch.sourceSnapshotRef);
      const sourceSnapshot = JSON.parse(sourceSnapshotEvidence.bytes.toString('utf8'));
      const resultingSnapshot = await captureWorkspace(workspaceRoot, { excluded: project.workspace.excluded ?? [] });
      const cumulativeChangedFiles = diffWorkspaceSnapshots(sourceSnapshot, resultingSnapshot);
      const interveningFiles = new Set(state.submissions.filter(submission => submission.inputSourceDigest === dispatch.sourceDigest && !submission.supersededAt).flatMap(submission => submission.changedFiles ?? []));
      const actualChangedFiles = cumulativeChangedFiles.filter(path => !interveningFiles.has(path));
      const claimedChangedFiles = [...new Set(validatedResult.changedFiles)].map(path => String(path).replaceAll('\\', '/')).sort();
      assert(digestJson(claimedChangedFiles) === digestJson(actualChangedFiles), 'RESULT_CHANGED_FILES_MISMATCH', 'Runtime changed-files claim does not match the workspace snapshot diff.', { claimedChangedFiles, actualChangedFiles });
      const verifiedResult = { ...validatedResult, changedFiles: actualChangedFiles };
      await atomicWriteJson(dispatch.outputRef, verifiedResult, { root: authorityStore.root });
      const preservedRuntimeEvidence = runtimeEvidence ? JSON.parse(JSON.stringify(runtimeEvidence)) : null;
      const evidence = await evidenceStore.put({ result: verifiedResult, runtimeEvidence: preservedRuntimeEvidence, inputSourceDigest: dispatch.sourceDigest, outputSourceDigest: resultingSnapshot.digest, sourceSnapshotRef: dispatch.sourceSnapshotRef }, { ...evidenceMetadata, mediaType: 'application/json', projectId, runId, epoch: state.epoch, generation: state.generation, featureId: dispatch.featureId, dispatchId, sourceDigest: dispatch.sourceDigest, artifactDigest: state.artifactDigest, policyDigest: state.policyDigest, pluginSetDigest: state.pluginSetDigest, labels: ['agent-result'] });
      return kernel.submit(projectId, runId, { dispatchId, outputRef: dispatch.outputRef, agentId: lease.agentId, packetDigest: dispatch.packetDigest, epoch: state.epoch, generation: state.generation, result: verifiedResult, resultingSourceDigest: resultingSnapshot.digest, evidenceRefs: [evidence.ref] }, { expectedRevision: state.revision, commandId });
    },

    async status(projectId, runId) {
      const state = await authorityStore.read(projectId, runId);
      return { authority: state, projection: profileRegistry.get(state.profile.id).project(state) };
    },
  };
  return api;
};
