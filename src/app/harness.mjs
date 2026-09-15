import { resolve } from 'node:path';
import { atomicWriteJson } from '../kernel/atomic-io.mjs';
import { AuthorityStore } from '../kernel/authority-store.mjs';
import { EvidenceStore } from '../kernel/evidence-store.mjs';
import { buildDispatchPacket, HarnessKernel } from '../kernel/kernel.mjs';
import { digestJson, sha256 } from '../canonical.mjs';
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
import { assertHarnessWritePath, harnessControlRoot } from '../write-boundary.mjs';
import { RunCoordinator } from '../coordinator/run-coordinator.mjs';
import { AUTO_CONCURRENCY, AUTO_CONCURRENCY_LIMIT, resolveConcurrencyLimit } from '../concurrency.mjs';
import { ProjectGateRunner } from '../gates/project-gate-runner.mjs';
import { assertAgentRuntimeCompatible, assertRuntimeTransportReceipt } from '../plugins/runtime/execution-policy.mjs';
import { assertFreshVisibleObservation, createVisibleHostAdapter, isVisibleHostAdapter } from '../plugins/runtime/visible-host-adapter.mjs';

export const defaultDataRoot = (controlRoot = harnessControlRoot()) => resolve(controlRoot, '.agent-harness-data');

const manifests = Object.freeze({
  scheduler: { id: 'reference-conflict-scheduler', kind: 'scheduler', version: '1.0.0', capabilities: ['feature-dag', 'conflict-graph', 'lane-fairness'], permissions: [] },
  codec: { id: 'reference-json-codec', kind: 'codec', version: '1.0.0', capabilities: ['json', 'structured-result'], permissions: [] },
  promptCodec: REFERENCE_AGENT_PROMPT_CODEC_MANIFEST,
  model: { id: 'reference-static-model-router', kind: 'model-router', version: '1.0.0', capabilities: ['capability-route', 'risk-route'], permissions: [] },
  storage: { id: 'reference-file-storage', kind: 'storage-provider', version: '1.0.0', capabilities: ['expected-revision', 'idempotency', 'atomic-write', 'recovery'], permissions: ['state.write'] },
});

export const createHarness = async ({ controlRoot: controlRootInput, dataRoot: dataRootInput, now, id, releaseIdentity, strictProjectIdentity = true, initializeStorage = true, allowedPluginPermissions = ['state.write', 'agent.conversation', 'process.spawn', 'workspace.read', 'workspace.write', 'gate.execute', 'artifact.read'], extraProfiles = [], extensions = [], agentAdapter = null } = {}) => {
  const controlRoot = harnessControlRoot(controlRootInput);
  const dataRoot = dataRootInput ?? defaultDataRoot(controlRoot);
  const controlledDataRoot = assertHarnessWritePath(dataRoot, 'Harness dataRoot', controlRoot);
  releaseIdentity ??= await loadReleaseIdentity();
  const currentReleaseIdentity = { version: releaseIdentity?.version, artifactDigest: releaseIdentity?.artifactDigest ?? null };
  assert(/^\d+\.\d+\.\d+$/.test(currentReleaseIdentity.version ?? ''), 'HARNESS_RELEASE_IDENTITY_INVALID', 'Harness release identity requires a semantic version.');
  assert(currentReleaseIdentity.artifactDigest === null || /^[a-f0-9]{64}$/.test(currentReleaseIdentity.artifactDigest), 'HARNESS_RELEASE_IDENTITY_INVALID', 'Harness artifact digest must be null or SHA-256.');
  if (strictProjectIdentity) assert(/^[a-f0-9]{64}$/.test(currentReleaseIdentity.artifactDigest ?? ''), 'HARNESS_RELEASE_ARTIFACT_REQUIRED', 'Production Harness creation requires a verified release artifact digest.');
  const authorityStore = new AuthorityStore({ root: controlledDataRoot, controlRoot, now });
  if (initializeStorage) await authorityStore.init();
  const evidenceStore = new EvidenceStore({ root: authorityStore.root, controlRoot, now });
  const trustedAgentAdapter = agentAdapter === null || agentAdapter === undefined
    ? null
    : isVisibleHostAdapter(agentAdapter)
      ? agentAdapter
      : typeof agentAdapter.inspectVisibleAgent === 'function'
        ? createVisibleHostAdapter(agentAdapter)
        : typeof agentAdapter.verifyVisibleLease === 'function' || typeof agentAdapter.heartbeatVisibleAgent === 'function'
          ? assert(false, 'VISIBLE_AGENT_HOST_ADAPTER_REQUIRED', 'Visible Agent host callbacks must be wrapped by createVisibleHostAdapter().')
          : agentAdapter;
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
  const recovery = new RecoveryCoordinator({ kernel, importers: extensionSet.recoveryImporters, controlRoot });
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

  const api = {
    dataRoot: authorityStore.root,
    controlRoot,
    authorityStore,
    evidenceStore,
    profileRegistry,
    pluginHost: publicPluginHost,
    projectRegistry,
    kernel: publicKernel,
    recovery,
    extensionSet: { installed: extensionSet.installed, digest: extensionSet.digest },
    releaseIdentity: Object.freeze(structuredClone(currentReleaseIdentity)),

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
      const derivedRunId = createLifecycleCommandPlan({
        intent,
        project,
        extension,
        releaseIdentity: { ...currentReleaseIdentity, verified: true },
        sourceDigest: snapshot.digest,
        executionWorkspaceRoot: workspace.root,
        authorityRevision: 0,
        compiler: extension.operations?.createLifecyclePlan,
      }).run.runId;
      const existing = await authorityStore.read(project.id, derivedRunId, { required: false });
      const plan = createLifecycleCommandPlan({
        intent,
        project,
        extension,
        releaseIdentity: { ...currentReleaseIdentity, verified: true },
        sourceDigest: snapshot.digest,
        executionWorkspaceRoot: workspace.root,
        authorityRevision: existing?.revision ?? 0,
        existingRunId: existing?.runId ?? null,
        compiler: extension.operations?.createLifecyclePlan,
      });
      if (existing) assert(existing.metadata?.lifecyclePlanDigest === plan.planDigest, 'LIFECYCLE_PLAN_RUN_CONFLICT', 'A Run with the deterministic lifecycle ID exists for a different Command Plan.', { runId: existing.runId, existingPlanDigest: existing.metadata?.lifecyclePlanDigest, planDigest: plan.planDigest });
      const runtimeManifest = pluginHost.get(plan.run.runtimePluginId, 'agent-runtime').manifest;
      assertAgentRuntimeCompatible({ project, manifest: runtimeManifest });
      return plan;
    },

    async startLifecyclePlan(planInput, { commandId } = {}) {
      assert(commandId, 'COMMAND_ID_REQUIRED', 'Lifecycle start requires a command ID.');
      const plan = validateLifecycleCommandPlan(planInput);
      const project = await projectRegistry.get(plan.project.id);
      assert(project.revision === plan.project.revision && project.descriptorDigest === plan.project.descriptorDigest, 'LIFECYCLE_PLAN_PROJECT_STALE', 'Lifecycle Command Plan is stale for the current Project Descriptor.');
      assert(currentReleaseIdentity.artifactDigest === plan.harness.artifactDigest && currentReleaseIdentity.version === plan.harness.version, 'LIFECYCLE_PLAN_RELEASE_STALE', 'Lifecycle Command Plan is stale for the active Harness release.');
      const runtimeManifest = pluginHost.get(plan.run.runtimePluginId, 'agent-runtime').manifest;
      const runtimePolicy = assertAgentRuntimeCompatible({ project, manifest: runtimeManifest });
      const existing = await authorityStore.read(plan.project.id, plan.run.runId, { required: false });
      if (runtimePolicy.hostOrchestrated && !isVisibleHostAdapter(trustedAgentAdapter)) {
        return { status: 'attention-required', reason: 'visible-agent-host-adapter-unavailable', planDigest: plan.planDigest, plan, runtimePolicy, state: existing };
      }
      let state = existing;
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
          metadata: { ...(plan.run.metadata ?? {}), lifecyclePlanDigest: plan.planDigest, commandIntent: plan.intent, stopCondition: plan.stopCondition },
        }, { commandId: `${commandId}.start` });
        state = started.state;
      } else {
        assert(state.metadata?.lifecyclePlanDigest === plan.planDigest, 'LIFECYCLE_PLAN_RUN_CONFLICT', 'Existing Run is bound to another Command Plan.');
      }
      return { status: state.status === 'closed' ? 'closed' : 'started', planDigest: plan.planDigest, plan, runtimePolicy, state };
    },

    async executeLifecyclePlan(planInput, { commandId, maxConcurrency, maxRounds = 100, forceFreshGates = true, onGateProgress = null } = {}) {
      assert(commandId, 'COMMAND_ID_REQUIRED', 'Lifecycle execution requires a command ID.');
      const started = await api.startLifecyclePlan(planInput, { commandId });
      if (started.status === 'attention-required') return started;
      const { plan, runtimePolicy } = started;
      let { state } = started;
      if (state.status === 'closed') return { status: 'closed', planDigest: plan.planDigest, state };
      assert(state.status !== 'superseded', 'LIFECYCLE_PLAN_RUN_SUPERSEDED', 'Lifecycle execution cannot resume a superseded Run.');
      if (runtimePolicy.hostOrchestrated) return { status: 'attention-required', reason: 'user-visible-runtime-requires-host-orchestration', planDigest: plan.planDigest, state };
      const coordinator = new RunCoordinator({ harness: api });
      const execution = await coordinator.run({ projectId: plan.project.id, runId: plan.run.runId, runtimePluginId: plan.run.runtimePluginId, maxConcurrency, maxRounds });
      state = await authorityStore.read(plan.project.id, plan.run.runId);
      if (!state.features.every(feature => feature.state === 'completed')) return { status: execution.status, planDigest: plan.planDigest, execution, state };
      const gateRunner = new ProjectGateRunner({ harness: api, onProgress: onGateProgress });
      const gates = await gateRunner.run({ projectId: plan.project.id, runId: plan.run.runId, scope: 'final', forceFresh: forceFreshGates, gateIds: plan.stopCondition.requiredFinalGates ?? [] });
      state = await authorityStore.read(plan.project.id, plan.run.runId);
      const closed = await api.kernel.closeRun(plan.project.id, plan.run.runId, {}, { expectedRevision: state.revision, commandId: `${commandId}.close` });
      return { status: 'closed', planDigest: plan.planDigest, execution, gates, state: closed.state };
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
      const runtimePolicy = assertAgentRuntimeCompatible({ project, manifest });
      assert(runtimePolicy.mode === 'headless', 'VISIBLE_AGENT_HOST_REQUIRED', 'Conversation-visible Agents must be controlled by the interactive host, not through Runtime plugin invocation.');
      return pluginHost.invoke(dispatch.runtimePluginId, method, { agentId: lease.agentId, ...structuredClone(input) });
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
      return kernel.startRun({ ...input, profileConfig, policyDigest, sourceDigest: input.sourceDigest ?? snapshot.digest, pluginSetDigest: input.pluginSetDigest ?? installedCompositionDigest, metadata: { ...input.metadata, workspace: structuredClone(workspace), projectDescriptorDigest: project.descriptorDigest, extensionSetDigest: extensionSet.digest } }, command);
    },

    async dispatch(projectId, runId, input, command) {
      const state = await authorityStore.read(projectId, runId);
      assert(state.revision === command.expectedRevision, 'REVISION_CONFLICT', 'Authority revision changed before scheduling.', { expected: command.expectedRevision, actual: state.revision });
      const project = await projectRegistry.get(projectId);
      const workspaceRoot = state.metadata?.workspace?.root ?? project.workspace.root;
      const runtimePluginId = input.runtimePluginId ?? project.policy?.defaultRuntimePlugin ?? null;
      assert(runtimePluginId, 'DEFAULT_RUNTIME_REQUIRED', `Project ${projectId} requires an explicit default Runtime.`);
      let runtimeManifest = null;
      let runtimePolicy = null;
      if (runtimePluginId) {
        assert((project.policy?.runtimePlugins ?? [runtimePluginId]).includes(runtimePluginId), 'PROJECT_RUNTIME_DENIED', `Runtime ${runtimePluginId} is not allowed by Project ${projectId}.`);
        runtimeManifest = pluginHost.get(runtimePluginId, 'agent-runtime').manifest;
        runtimePolicy = assertAgentRuntimeCompatible({ project, manifest: runtimeManifest });
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
      const runtimePolicy = assertAgentRuntimeCompatible({ project, manifest });
      assert(!runtimePolicy.hostOrchestrated, 'VISIBLE_AGENT_HOST_REQUIRED', `Runtime ${runtimePluginId} must be started by the interactive host as a visible child Agent.`);
      const { packet, prompt } = await compileDispatchPrompt(state, dispatch);
      const runtime = await pluginHost.invoke(runtimePluginId, 'spawn', packet, { prompt });
      const payload = runtime.payload;
      const bound = await api.bindDispatch(projectId, runId, { dispatchId, agentId: payload.agentId, runtimeReceipt: payload.transportReceipt }, { expectedRevision: state.revision, commandId });
      return { packet, prompt, runtimeReceipt: runtime, lease: bound.result.lease, state: bound.state };
    },

    async readDispatchPacket(projectId, runId, dispatchId) {
      const state = await authorityStore.read(projectId, runId);
      const dispatch = state.dispatches.find(item => item.dispatchId === dispatchId);
      assert(dispatch?.status === 'requested', 'DISPATCH_NOT_READABLE', `Dispatch is not awaiting a visible Agent: ${dispatchId}`);
      const { packet, prompt } = await compileDispatchPrompt(state, dispatch);
      return { dispatch: structuredClone(dispatch), packet, prompt };
    },

    async bindDispatch(projectId, runId, input, command) {
      const state = await authorityStore.read(projectId, runId);
      assert(state.revision === command.expectedRevision, 'REVISION_CONFLICT', 'Authority revision changed before Runtime binding.', { expected: command.expectedRevision, actual: state.revision });
      const dispatch = state.dispatches.find(item => item.dispatchId === input.dispatchId);
      assert(dispatch?.status === 'requested', 'DISPATCH_NOT_BINDABLE', `Dispatch is not awaiting a Runtime: ${input.dispatchId}`);
      const project = await projectRegistry.get(projectId);
      const manifest = pluginHost.get(dispatch.runtimePluginId, 'agent-runtime').manifest;
      const runtimePolicy = assertRuntimeTransportReceipt({ project, manifest, receipt: input.runtimeReceipt });
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
      return kernel.bindLease(projectId, runId, { dispatchId: dispatch.dispatchId, agentId: input.agentId, packetDigest: dispatch.packetDigest, runtimeReceipt }, command);
    },

    async recordHeartbeat(projectId, runId, input, command) {
      const state = await authorityStore.read(projectId, runId);
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
      const dispatch = state.dispatches.find(item => item.dispatchId === dispatchId);
      const lease = state.leases.find(item => item.dispatchId === dispatchId && item.status === 'active');
      assert(dispatch && lease, 'ACTIVE_LEASE_REQUIRED', `Dispatch does not have an active Lease: ${dispatchId}`);
      if (dispatch.execution?.runtime?.mode === 'conversation-visible') {
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
      const claimedChangedFiles = [...new Set(result.changedFiles ?? [])].map(path => String(path).replaceAll('\\', '/')).sort();
      if (result.changedFiles) assert(digestJson(claimedChangedFiles) === digestJson(actualChangedFiles), 'RESULT_CHANGED_FILES_MISMATCH', 'Runtime changed-files claim does not match the workspace snapshot diff.', { claimedChangedFiles, actualChangedFiles });
      const verifiedResult = { ...structuredClone(result), changedFiles: actualChangedFiles };
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
