import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, rm } from 'node:fs/promises';
import { atomicWriteJson } from '../kernel/atomic-io.mjs';
import { AuthorityStore } from '../kernel/authority-store.mjs';
import { EvidenceStore } from '../kernel/evidence-store.mjs';
import { buildDispatchPacket, HarnessKernel, leaseHealth } from '../kernel/kernel.mjs';
import { digestJson, newId, sha256 } from '../common/canonical.mjs';
import { assert } from '../common/errors.mjs';
import { PluginHost } from '../platform/plugins/host.mjs';
import { createConflictScheduler } from '../platform/plugins/scheduler/conflict-scheduler.mjs';
import { createJsonCodec } from '../platform/plugins/codec/json-codec.mjs';
import { AGENT_PROMPT_CONTRACT_VERSION, createAgentPromptCodec, REFERENCE_AGENT_PROMPT_CODEC_MANIFEST } from '../platform/plugins/codec/agent-prompt-codec.mjs';
import { createStaticModelRouter } from '../platform/plugins/model/static-router.mjs';
import { createAuthorityStoragePlugin } from '../platform/plugins/storage/authority-storage.mjs';
import { featureDeliveryProfile } from '../flow-kit/profiles/feature-delivery.mjs';
import { ProfileRegistry } from '../platform/workflow/profiles/registry.mjs';
import { ProjectRegistry } from '../platform/registry/project-registry.mjs';
import { WorkspaceRegistry, parseWorkspaceProjectionId } from '../platform/workspace/workspace-registry.mjs';
import { ResourceProviderRegistry } from '../platform/workspace/resource-provider.mjs';
import { createWorkspaceMemoryBroker } from '../platform/workspace/memory-broker.mjs';
import { RecoveryCoordinator } from '../platform/recovery/coordinator.mjs';
import { installExtensionPacks } from '../platform/extensions/contract.mjs';
import { resolveCommandIntent } from '../platform/extensions/command-contract.mjs';
import { createLifecycleCommandPlan, validateLifecycleCommandPlan } from './lifecycle-command-plan.mjs';
import { createExecutionReadinessReport as buildExecutionReadinessReport } from './execution-readiness-service.mjs';
import { executeHeadlessLifecyclePlan, executeVisibleLifecyclePlan as runVisibleLifecyclePlan } from './lifecycle-execution-service.mjs';
import { loadReleaseIdentity } from './release-identity.mjs';
import { preparePrereleaseIntent, readReleaseForKind, promoteReleaseForKind } from './release-variant.mjs';
import { captureWorkspace, diffWorkspaceSnapshots } from '../common/workspace-snapshot.mjs';
import { resolveProjectWorkspace } from '../common/workspace-identity.mjs';
import { MemoryStore } from '../platform/resources/memory/memory-store.mjs';
import { verifySourceManifest, assertSourceManifestCurrent, readPinnedSource } from '../platform/workflow/source-manifest.mjs';
import { createWorkspaceLifecyclePlanner } from './workspace-lifecycle-planner.mjs';
import { assertHarnessWritePath, harnessControlRoot, harnessProjectRoot } from '../common/write-boundary.mjs';
import { RunCoordinator } from '../platform/workflow/coordinator/run-coordinator.mjs';
import { AUTO_CONCURRENCY, AUTO_CONCURRENCY_LIMIT, resolveConcurrencyLimit } from '../common/concurrency.mjs';
import { ProjectGateRunner, assertIssuedGateInvocation, assertIssuedGateSubmission, inspectProjectGateCapabilities } from '../platform/workflow/gates/project-gate-runner.mjs';
import { assertAgentRuntimeCompatible, assertRuntimeTransportReceipt, resolveLifecycleExecutionPolicy } from '../platform/plugins/runtime/execution-policy.mjs';
import { assertFreshVisibleObservation, isVisibleHostAdapter } from '../platform/plugins/runtime/visible-host-adapter.mjs';
import { assertVisibleHostReceiptOwner, createVisibleHostBindings } from '../platform/plugins/runtime/visible-host-bindings.mjs';
import { assertDispatchResultContract, createDispatchResultContract, validateBusinessResult, validateProfileResult } from '../platform/execution/result-contract.mjs';
import { sealLegacyFindingInventory } from '../platform/execution/known-finding-inventory.mjs';
import { createQualityCloseoutSnapshot, createQualityInventorySnapshot, createQualityRepairInventorySnapshot, deriveQualityTargetSnapshot } from '../platform/execution/quality-target.mjs';
import { sealExecutionReadinessReport, verifyExecutionReadinessReport } from './execution-readiness.mjs';
import { readActiveRelease, resolveActiveRuntimeRoot } from '../platform/registry/active-generation.mjs';
import { RunLineageStore, resolveRunLineage, verifyRunLineageResolution } from './lineage.mjs';
import { ensurePlanApprovalArtifact, planApprovalSatisfied, planApprovalSnapshot, reviewedPlanProposal } from '../flows/delivery-lifecycle/plan-approval.mjs';
import { expandApprovedImplementation } from '../flows/delivery-lifecycle/approved-implementation.mjs';
import { assessAutomaticPlanSourceCompatibility, assessPlanSourceCompatibility, assessRecoveredImplementationContinuation, assessVerifiedImplementationContinuation, matchingPlanSourceCompatibilityDecision } from './plan-source-compatibility.mjs';
import { preparePlanRevisionIntent } from './plan-revision.mjs';
import {
  buildExecutionGrantContext,
  createAgentRuntimeLaunchCapability,
  isExecutionAuthorizationAdapter,
  issueHeadlessExecutionGrant,
  resolveExecutionConstraints,
  verifyHeadlessExecutionGrant,
} from '../platform/execution/authorization.mjs';

export const defaultDataRoot = (controlRoot = harnessControlRoot()) => resolve(controlRoot, '.agent-harness-data');

const manifests = Object.freeze({
  scheduler: { id: 'reference-conflict-scheduler', kind: 'scheduler', version: '1.0.0', capabilities: ['feature-dag', 'conflict-graph', 'lane-fairness'], permissions: [] },
  codec: { id: 'reference-json-codec', kind: 'codec', version: '1.0.0', capabilities: ['json', 'structured-result'], permissions: [] },
  promptCodec: REFERENCE_AGENT_PROMPT_CODEC_MANIFEST,
  model: { id: 'reference-static-model-router', kind: 'model-router', version: '1.0.0', capabilities: ['capability-route', 'risk-route'], permissions: [] },
  storage: { id: 'reference-file-storage', kind: 'storage-provider', version: '1.0.0', capabilities: ['expected-revision', 'idempotency', 'atomic-write', 'recovery'], permissions: ['state.write'] },
});

export const createHarness = async ({ controlRoot: controlRootInput, dataRoot: dataRootInput, workspaceId = null, memoryRoot = null, now, id, releaseIdentity, strictProjectIdentity = true, initializeStorage = true, allowedPluginPermissions = ['state.write', 'agent.conversation', 'workspace.read', 'workspace.write', 'gate.execute', 'artifact.read'], extraProfiles = [], extensions = [], agentAdapter = null, agentAdapters = {}, executionAuthorizationAdapter = null } = {}) => {
  const controlRoot = harnessControlRoot(controlRootInput);
  const globalDataRoot = assertHarnessWritePath(dataRootInput ?? defaultDataRoot(controlRoot), 'Harness global dataRoot', controlRoot);
  const workspaceRegistry = new WorkspaceRegistry({ root: globalDataRoot, controlRoot, now });
  if (workspaceId) assert(/^[a-z][a-z0-9-]{0,31}$/.test(workspaceId), 'WORKSPACE_ID_INVALID', 'Workspace ID is invalid.');
  const dataRoot = workspaceId ? resolve(globalDataRoot, 'workspaces', workspaceId) : globalDataRoot;
  const controlledDataRoot = assertHarnessWritePath(dataRoot, 'Harness dataRoot', controlRoot);
  const activeRelease = await readActiveRelease(globalDataRoot, controlRoot);
  const activeRuntimeRoot = activeRelease ? await resolveActiveRuntimeRoot(globalDataRoot, controlRoot) : null;
  releaseIdentity ??= await loadReleaseIdentity();
  const currentReleaseIdentity = { version: releaseIdentity?.version, artifactDigest: releaseIdentity?.artifactDigest ?? null };
  assert(/^\d+\.\d+\.\d+$/.test(currentReleaseIdentity.version ?? ''), 'HARNESS_RELEASE_IDENTITY_INVALID', 'Harness release identity requires a semantic version.');
  assert(currentReleaseIdentity.artifactDigest === null || /^[a-f0-9]{64}$/.test(currentReleaseIdentity.artifactDigest), 'HARNESS_RELEASE_IDENTITY_INVALID', 'Harness artifact digest must be null or SHA-256.');
  if (strictProjectIdentity) assert(/^[a-f0-9]{64}$/.test(currentReleaseIdentity.artifactDigest ?? ''), 'HARNESS_RELEASE_ARTIFACT_REQUIRED', 'Production Harness creation requires a verified release artifact digest.');
  const authorityStore = new AuthorityStore({ root: controlledDataRoot, controlRoot, now });
  if (initializeStorage) await authorityStore.init();
  const evidenceStore = new EvidenceStore({ root: authorityStore.root, controlRoot, now });
  const memoryStore = new MemoryStore({ controlRoot, root: memoryRoot ?? resolve(authorityStore.root, 'memory'), authorityStore, now });
  const resourceProviders = new ResourceProviderRegistry({ memoryStore });
  const workspaceMemoryBroker = workspaceId ? createWorkspaceMemoryBroker({ workspaceId, workspaceRegistry, providerRegistry: resourceProviders, memoryStore, authorityStore }) : null;
  const lineageStore = new RunLineageStore({ root: authorityStore.root, controlRoot, now });
  const visibleHostBindings = createVisibleHostBindings({ agentAdapter, agentAdapters });
  const resolveVisibleHostAdapter = runtimePluginId => visibleHostBindings.resolve(runtimePluginId);
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
  const projectRegistry = new ProjectRegistry({ root: authorityStore.root, controlRoot, now, strictIdentity: strictProjectIdentity, workspaceRegistry, workspaceId });
  const workspacePlanToken = Symbol('workspace-plan-token');
  const extensionSet = await installExtensionPacks(extensions, {
    profileRegistry,
    pluginHost,
    resourceProviderRegistry: resourceProviders,
    factoryContext: { controlRoot, dataRoot: authorityStore.root, resolveProject: projectId => projectRegistry.get(projectId), now, resolveAgentAdapter: resolveVisibleHostAdapter },
    requireVerifiedArtifacts: strictProjectIdentity,
  });
  visibleHostBindings.assertInstalled(pluginHost);
  const kernel = new HarnessKernel({ authorityStore, evidenceStore, profiles: profileRegistry, now, id });
  const recovery = new RecoveryCoordinator({ kernel, importers: extensionSet.recoveryImporters, projectRegistry, controlRoot });
  const extensionPacks = new Map(extensions.map(extension => [extension.id, extension]));
  const publicKernel = new Proxy(kernel, {
    get(target, property) {
      if (['bindLease', 'heartbeat', 'recordGate'].includes(property)) return async () => assert(false, property === 'heartbeat' ? 'DIRECT_HEARTBEAT_DENIED' : property === 'bindLease' ? 'DIRECT_LEASE_BIND_DENIED' : 'DIRECT_GATE_RESULT_DENIED', property === 'heartbeat' ? 'Heartbeat must use the policy-aware Harness recordHeartbeat API.' : property === 'bindLease' ? 'Lease binding must use the policy-aware Harness bindDispatch API.' : 'Gate results must come from a verified Gate Runner.');
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
    if (binding.contractVersion === AGENT_PROMPT_CONTRACT_VERSION) assertDispatchResultContract(dispatch.execution?.result, feature, { conversationVisible: dispatch.execution?.runtime?.mode === 'conversation-visible' });
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
    const policy = assertAgentRuntimeCompatible({ project, manifest, action, workflowId: state.metadata?.workflow?.id, runtimePluginId: lifecycleExecution?.runtimePluginId ?? manifest.id, agentExecutionMode: lifecycleExecution?.agentExecutionMode });
    if (policy.mode !== 'headless') return { policy, constraints: executionConstraints, grant: null, verification: null };
    assert(lifecycleExecution?.executionConstraintDigest === executionConstraints.constraintDigest, 'EXECUTION_CONSTRAINT_STALE', 'Run was authorized under different trusted execution constraints.');
    const currentPolicyDigest = digestJson({ profiles: project.profiles, extensions: project.extensions ?? [], ...(project.workflows ? { workflows: project.workflows } : {}), policy: project.policy ?? {}, gateRecipes: project.gateRecipes ?? [], artifactProviders: project.artifactProviders ?? [] });
    if (!state.metadata?.workspaceRef) assert(currentPolicyDigest === state.policyDigest, 'RUN_EXECUTION_POLICY_STALE', 'Project execution policy changed after this Run was authorized.');
    const pinnedProject = { ...project, revision: lifecycleExecution.executionGrant?.context?.projectRevision, descriptorDigest: state.metadata?.projectDescriptorDigest };
    const context = grantContextFor({ project: pinnedProject, intent: state.metadata?.commandIntent ?? null, runId: state.runId, runtimePluginId: manifest.id, runtimeVersion: manifest.version, executionWorkspaceRoot: state.metadata?.workspace?.root ?? project.workspace.root, sourceDigest: lifecycleExecution.authorizationSourceDigest, harnessArtifactDigest: lifecycleExecution.harnessArtifactDigest, extensionDigest: lifecycleExecution.extensionDigest, constraintDigest: lifecycleExecution.executionConstraintDigest });
    const authorized = await verifyHeadlessExecutionGrant({ adapter: trustedExecutionAuthorizationAdapter, grant: lifecycleExecution.executionGrant, context, manifest, now: kernel.now });
    return { policy, ...authorized };
  };

  const assertWorkspaceRunAccess = async (state, receiverId = null) => {
    const ref = state.metadata?.workspaceRef;
    if (!ref) return null;
    assert(workspaceId === ref.workspaceId, 'WORKSPACE_RUN_SCOPE_DENIED', 'Run belongs to another Workspace.');
    const current = await workspaceRegistry.get(ref.workspaceId);
    const binding = current.workflows.find(item => item.id === ref.workflowId);
    const target = current.executionTargets.find(item => item.id === ref.executionTargetId);
    assert(binding && binding.executionTargetId === ref.executionTargetId && target && ref.projectIds.every(id => binding.allowedProjectIds.includes(id) && target.projectIds.includes(id)), 'WORKSPACE_RUN_ACCESS_REVOKED', 'Workflow, Project, or execution target access was revoked.');
    for (const source of state.metadata?.sourceManifest?.sources ?? []) {
      const configured = current.sources.find(item => item.sourceId === source.sourceId);
      assert(configured && resolve(configured.root) === resolve(source.root) && ref.projectIds.some(id => current.projects.find(project => project.id === id)?.sourceIds.includes(source.sourceId)) && (!receiverId || configured.allowedReceivers.includes(receiverId)), 'WORKSPACE_SOURCE_ACCESS_REVOKED', `Source ${source.sourceId} access was revoked.`);
    }
    for (const id of ref.resourceIds ?? []) {
      const resource = current.resources.find(item => item.id === id);
      assert(resource && (resource.scope === 'project' ? ref.projectIds.includes(resource.projectId) && resource.readProjectIds.includes(resource.projectId) : ref.projectIds.every(projectId => resource.readProjectIds.includes(projectId))), 'WORKSPACE_RESOURCE_ACCESS_REVOKED', `Resource ${id} access was revoked.`);
      resourceProviders.resolve(resource);
    }
    return current;
  };

  const serviceContext = {
    controlRoot,
    authorityStore,
    lineageStore,
    projectRegistry,
    workspaceRegistry,
    workspaceId,
    kernel,
    pluginHost,
    profileRegistry,
    extensionSet,
    executionConstraints,
    currentReleaseIdentity,
    strictProjectIdentity,
    activeRelease,
    activeRuntimeRoot,
    resolveVisibleHostAdapter,
    verifyPlanExecutionAuthorization,
    compileDispatchPrompt,
  };
  const planWorkspaceLifecycle = createWorkspaceLifecyclePlanner({ workspaceId, workspaceRegistry, resourceProviders, workspacePlanToken, createLifecyclePlan: input => api.createLifecyclePlan(input) });
  const api = {
    dataRoot: authorityStore.root,
    controlRoot,
    authorityStore,
    lineageStore,
    evidenceStore,
    memoryStore: workspaceMemoryBroker ?? memoryStore,
    profileRegistry,
    pluginHost: publicPluginHost,
    projectRegistry,
    workspaceRegistry,
    workspaceId,
    kernel: publicKernel,
    recovery,
    extensionSet: { installed: extensionSet.installed, digest: extensionSet.digest },
    releaseIdentity: Object.freeze(structuredClone(currentReleaseIdentity)),

    async readVersionRelease(projectId, target) {
      await projectRegistry.get(projectId);
      return readReleaseForKind({ kind: 'version', dataRoot: authorityStore.root, projectId, target });
    },

    async promoteVersionRelease({ projectId, target, candidateDigest, expectedRevision, commandId, approval }) {
      const project = await projectRegistry.get(projectId);
      const workspace = await resolveProjectWorkspace(project);
      return promoteReleaseForKind({ kind: 'version', dataRoot: authorityStore.root, project, target, workspaceRoot: workspace.root,
        candidateDigest, expectedRevision, commandId, approval });
    },

    async readScopedRelease(projectId, target) {
      await projectRegistry.get(projectId);
      return readReleaseForKind({ kind: 'scoped', dataRoot: authorityStore.root, projectId, target });
    },

    async promoteScopedRelease({ projectId, target, candidateDigest, expectedRevision, commandId, approval }) {
      const project = await projectRegistry.get(projectId);
      const workspace = await resolveProjectWorkspace(project);
      return promoteReleaseForKind({ kind: 'scoped', dataRoot: authorityStore.root, project, target, workspaceRoot: workspace.root,
        candidateDigest, expectedRevision, commandId, approval });
    },

    async readPinnedSourceForDispatch(projectId, runId, dispatchId, sourceId, path) {
      const state = await authorityStore.read(projectId, runId);
      const dispatch = state.dispatches.find(item => item.dispatchId === dispatchId && ['requested', 'assigned'].includes(item.status));
      assert(dispatch, 'SOURCE_DISPATCH_INVALID', 'Pinned source read requires a live Dispatch.');
      await assertWorkspaceRunAccess(state, dispatch.runtimePluginId);
      assert((dispatch.featureSnapshot?.metadata?.sourceIds ?? []).includes(sourceId), 'SOURCE_FEATURE_SCOPE_DENIED', `Feature cannot read source ${sourceId}.`);
      return readPinnedSource(state.metadata.sourceManifest, { sourceId, path, receiverId: dispatch.runtimePluginId });
    },

    async createExecutionReadinessReport(planInput, options) {
      return buildExecutionReadinessReport(serviceContext, planInput, options);
    },

    async createWorkspaceLifecyclePlan(input) {
      return planWorkspaceLifecycle(input);
    },

    async createLifecyclePlan(input) {
      if (input.workspaceId || input.workspaceAlias) return api.createWorkspaceLifecyclePlan(input);
      if (parseWorkspaceProjectionId(input.projectId)) assert(input[workspacePlanToken] === true, 'WORKSPACE_PLAN_ENTRY_REQUIRED', 'Workspace plans must resolve bindings through createWorkspaceLifecyclePlan.');
      else assert(!input.workspaceRef, 'WORKSPACE_PLAN_ENTRY_REQUIRED', 'Workspace identity requires a Workspace Project.');
      const project = await projectRegistry.get(input.projectId);
      const workspace = await resolveProjectWorkspace(project, input.executionWorkspaceRoot);
      const boundCandidates = (project.extensions ?? []).map(required => extensionPacks.get(required.id)).filter(pack => pack?.commandManifest);
      const workflowCandidates = input.workflowId ? boundCandidates.filter(pack => pack.workflows?.some(workflow => workflow.id === input.workflowId)) : boundCandidates;
      assert(!input.workflowId || workflowCandidates.length === 1, 'WORKFLOW_SELECTION_INVALID', `Workflow ${input.workflowId} is not uniquely bound to Project ${project.id}.`);
      assert(input.extensionId || workflowCandidates.length === 1, 'WORKFLOW_SELECTION_REQUIRED', `Project ${project.id} requires an explicit workflow selection.`);
      const extensionId = input.extensionId ?? workflowCandidates[0]?.id;
      const extension = extensionPacks.get(extensionId);
      assert(extension, 'PROJECT_COMMAND_EXTENSION_MISSING', `No loaded Extension Pack can plan commands for Project ${project.id}.`);
      assert(extension.commandManifest, 'COMMAND_MANIFEST_MISSING', `Extension ${extension.id} does not provide a Command Manifest.`);
      if (input.workflowId) assert(extension.workflows?.some(workflow => workflow.id === input.workflowId), 'WORKFLOW_EXTENSION_MISMATCH', 'Selected Extension does not provide the requested workflow.');
      const selectedWorkflow = extension.workflows?.find(workflow => workflow.id === (input.workflowId ?? extension.commandManifest.workflowId));
      if (project.workflows?.length) {
        const binding = project.workflows.find(workflow => workflow.id === selectedWorkflow?.id);
        assert(binding && binding.extensionId === extension.id && binding.version === selectedWorkflow.version && binding.artifactDigest === selectedWorkflow.artifactDigest, 'PROJECT_WORKFLOW_IDENTITY_MISMATCH', 'Project does not bind the exact Workflow Definition.');
      }
      assert(extension.commandManifest.profileId === input.profileId || !input.profileId, 'COMMAND_PROFILE_MISMATCH', 'Command Profile does not match the selected Extension Manifest.');
      const resolvedIntent = resolveCommandIntent(extension.commandManifest, input);
      const workflowInput = input.workflowInput ? structuredClone(input.workflowInput) : null;
      if (workflowInput) {
        assert(workflowInput.sourceManifest, 'WORKFLOW_SOURCE_MANIFEST_REQUIRED', 'Workflow input requires a pinned Source Manifest.');
        verifySourceManifest(workflowInput.sourceManifest);
        await assertSourceManifestCurrent(workflowInput.sourceManifest);
        assert(!Object.hasOwn(workflowInput, 'memorySnapshot'), 'WORKFLOW_MEMORY_SNAPSHOT_FORBIDDEN', 'Memory snapshot is selected by the Harness.');
        workflowInput.memorySnapshot = await memoryStore.query({ spaces: workflowInput.memorySpaces ?? [], workflowId: resolvedIntent.workflowId, projectId: project.id, manifest: workflowInput.sourceManifest, topic: workflowInput.memoryTopic ?? null, sessionId: workflowInput.sessionId ?? null });
      }
      let intent = workflowInput ? { ...structuredClone(resolvedIntent), workflowInput } : resolvedIntent;
      assert(project.profiles.includes(intent.profileId), 'PROJECT_PROFILE_DENIED', `Project ${project.id} does not allow Profile ${intent.profileId}.`);
      const required = project.extensions?.find(item => item.id === extension.id);
      assert(required, 'PROJECT_EXTENSION_NOT_BOUND', `Project ${project.id} does not bind Extension ${extension.id}.`);
      assert(required.version === extension.version && required.digest === extension.digest, 'PROJECT_EXTENSION_IDENTITY_MISMATCH', `Project ${project.id} does not bind the active Extension ${extension.id}.`);
      if (strictProjectIdentity) assert(project.harness?.version === currentReleaseIdentity.version && project.harness?.artifactDigest === currentReleaseIdentity.artifactDigest, 'PROJECT_HARNESS_IDENTITY_MISMATCH', `Project ${project.id} does not bind the active Harness release.`);
      const snapshot = await captureWorkspace(workspace.root, { excluded: project.workspace.excluded ?? [] });
      if (intent.action === 'replan') {
        const released = await api.readVersionRelease(project.id, intent.target);
        assert(released?.state?.status !== 'released', 'REPLAN_VERSION_RELEASED', 'A released version requires a new target or a separately authorized patch release.');
        intent = preparePlanRevisionIntent({ intent, project, states: await authorityStore.list(project.id), sourceDigest: snapshot.digest });
      }
      if (intent.action === 'prerelease') {
        intent = await preparePrereleaseIntent({ intent, extension, project, snapshot, workspace, authorityStore, evidenceStore });
      }
      if (extension.planningCapabilities.includes('quality-target')) {
        if (extension.operations.resolveQualityScopes && ['quality', 'full'].includes(intent.action)) {
          const declaredScopes = extension.operations.resolveQualityScopes({ project: structuredClone(project), target: intent.target });
          const scopes = intent.selector ? declaredScopes?.filter(scope => scope.id === intent.selector) : declaredScopes;
          assert(Array.isArray(scopes) && scopes.length > 0 && new Set(scopes.map(scope => scope.id)).size === scopes.length
            && scopes.every(scope => typeof scope.id === 'string' && scope.id.length > 0 && typeof scope.root === 'string' && scope.root.length > 0),
          'QUALITY_SCOPES_INVALID', 'The bound Extension must declare unique quality scopes for the target.');
          const runs = await authorityStore.list(project.id);
          const qualityTargets = {};
          const qualityRepairInventories = {};
          const qualityCloseouts = {};
          const knownFindingInventories = {};
          for (const scope of scopes) {
            const target = deriveQualityTargetSnapshot({ projectId: project.id, workflowId: intent.workflowId, target: intent.target,
              sourceDigest: snapshot.digest, runs, scopeRoot: scope.root,
              includeNonterminal: intent.action === 'quality' && ['repair-known', 'closeout'].includes(intent.preset) });
            qualityTargets[scope.id] = target;
            if (intent.action === 'quality' && intent.preset === 'repair-known') {
              const inventory = createQualityRepairInventorySnapshot(target);
              qualityRepairInventories[scope.id] = inventory;
            } else if (intent.action === 'quality' && intent.preset === 'closeout') qualityCloseouts[scope.id] = createQualityCloseoutSnapshot(target);
            else if (['quality', 'full'].includes(intent.action)) knownFindingInventories[scope.id] = createQualityInventorySnapshot(target);
          }
          if (intent.action === 'quality' && intent.preset === 'repair-known'
            && Object.values(qualityRepairInventories).every(inventory => inventory.findings.length === 0)) {
            for (const scope of scopes) qualityCloseouts[scope.id] = createQualityCloseoutSnapshot(qualityTargets[scope.id]);
          }
          intent = { ...intent, qualityTargets, ...(Object.keys(qualityRepairInventories).length ? { qualityRepairInventories } : {}),
            ...(Object.keys(qualityCloseouts).length ? { qualityCloseouts } : {}),
            ...(Object.keys(knownFindingInventories).length ? { knownFindingInventories } : {}) };
        } else if (!extension.operations.resolveQualityScopes) {
        const inventoryDeclaration = project.policy?.knownFindingInventories?.[intent.target];
        const legacyInventory = inventoryDeclaration
          ? sealLegacyFindingInventory({ projectId: project.id, target: intent.target, declaration: inventoryDeclaration })
          : null;
        const qualityTarget = deriveQualityTargetSnapshot({
          projectId: project.id,
          workflowId: intent.workflowId,
          target: intent.target,
          sourceDigest: snapshot.digest,
          runs: await authorityStore.list(project.id),
          legacyInventory,
          includeNonterminal: intent.action === 'quality' && ['repair-known', 'closeout'].includes(intent.preset),
        });
        intent = { ...intent, qualityTarget };
        if (intent.action === 'quality' && intent.preset === 'repair-known') {
          intent.qualityRepairInventory = createQualityRepairInventorySnapshot(qualityTarget);
          if (intent.qualityRepairInventory.findings.length === 0) intent.qualityCloseout = createQualityCloseoutSnapshot(qualityTarget);
        } else if (intent.action === 'quality' && intent.preset === 'closeout') intent.qualityCloseout = createQualityCloseoutSnapshot(qualityTarget);
        else if (['implement', 'quality', 'full', 'deliver'].includes(intent.action)) intent.knownFindingInventory = createQualityInventorySnapshot(qualityTarget);
        }
      }
      const sourceToolBinding = workflowInput ? { commandPrefix: [process.execPath, fileURLToPath(new URL('../interfaces/cli/index.mjs', import.meta.url)), 'source'], controlRoot, dataRoot: authorityStore.root } : null;
      const executionPolicy = resolveLifecycleExecutionPolicy({ project, action: intent.action, workflowId: intent.workflowId });
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
        workspaceRef: input.workspaceRef ?? null,
        executionConstraintDigest: executionConstraints.constraintDigest,
        sourceToolBinding,
        executionGrant,
        compiler: extension.operations?.createLifecyclePlan,
      });
      if (executionPolicy.mode === 'headless' && executionGrant === null && input.executionAuthorizationEvidence !== undefined && isExecutionAuthorizationAdapter(trustedExecutionAuthorizationAdapter)) {
        const context = grantContextFor({ project, intent, runId: plan.run.runId, runtimePluginId: executionPolicy.runtimePluginId, runtimeVersion: runtimeManifest.version, executionWorkspaceRoot: workspace.root, sourceDigest: snapshot.digest, extensionDigest: extension.digest, constraintDigest: executionConstraints.constraintDigest });
        executionGrant = await issueHeadlessExecutionGrant({ adapter: trustedExecutionAuthorizationAdapter, context, evidence: input.executionAuthorizationEvidence });
        plan = createLifecycleCommandPlan({ intent, project, extension, releaseIdentity: { ...currentReleaseIdentity, verified: true }, sourceDigest: snapshot.digest, executionWorkspaceRoot: workspace.root, workspaceIdentity: workspace.identity ?? { type: 'descriptor-root', root: workspace.root }, workspaceRef: input.workspaceRef ?? null, executionConstraintDigest: executionConstraints.constraintDigest, executionGrant, sourceToolBinding, compiler: extension.operations?.createLifecyclePlan });
      }
      assertAgentRuntimeCompatible({ project, manifest: runtimeManifest, action: plan.intent.action, workflowId: plan.workflow?.id, runtimePluginId: plan.run.runtimePluginId, agentExecutionMode: plan.run.agentExecutionMode });
      return plan;
    },

    async startLifecyclePlan(planInput, { commandId, preflightReport } = {}) {
      assert(commandId, 'COMMAND_ID_REQUIRED', 'Lifecycle start requires a command ID.');
      const plan = validateLifecycleCommandPlan(planInput);
      if (plan.intent.workflowInput?.sourceManifest) await assertSourceManifestCurrent(plan.intent.workflowInput.sourceManifest);
      verifyExecutionReadinessReport(preflightReport, { plan, now: preflightReport?.createdAt });
      const project = await projectRegistry.get(plan.project.id);
      assert(project.revision === plan.project.revision && project.descriptorDigest === plan.project.descriptorDigest, 'LIFECYCLE_PLAN_PROJECT_STALE', 'Lifecycle Command Plan is stale for the current Project Descriptor.');
      if (plan.workspaceRef) {
        const current = await workspaceRegistry.get(plan.workspaceRef.workspaceId);
        assert(current.revision === plan.workspaceRef.revision && current.descriptorDigest === plan.workspaceRef.descriptorDigest, 'LIFECYCLE_PLAN_WORKSPACE_STALE', 'Workspace changed after planning.');
        assert(plan.intent.workflowInput?.sourceManifest?.workspaceRef?.descriptorDigest === current.descriptorDigest || !plan.intent.workflowInput, 'LIFECYCLE_PLAN_SOURCE_SCOPE_MISMATCH', 'Source Manifest is not bound to the Workspace revision.');
      }
      assert(currentReleaseIdentity.artifactDigest === plan.harness.artifactDigest && currentReleaseIdentity.version === plan.harness.version, 'LIFECYCLE_PLAN_RELEASE_STALE', 'Lifecycle Command Plan is stale for the active Harness release.');
      const runtimeManifest = pluginHost.get(plan.run.runtimePluginId, 'agent-runtime').manifest;
      const runtimePolicy = assertAgentRuntimeCompatible({ project, manifest: runtimeManifest, action: plan.intent.action, workflowId: plan.workflow?.id, runtimePluginId: plan.run.runtimePluginId, agentExecutionMode: plan.run.agentExecutionMode });
      const trustedAgentAdapter = resolveVisibleHostAdapter(plan.run.runtimePluginId);
      await verifyPlanExecutionAuthorization({ project, plan, manifest: runtimeManifest });
      const commitCommandDecisions = async initialState => {
        let state = initialState;
        const profile = profileRegistry.get(state.profile.id);
        const decisions = profile.commandDecisions?.(state) ?? [];
        assert(Array.isArray(decisions), 'PROFILE_COMMAND_DECISIONS_INVALID', `Profile ${profile.id} must return a Decision list.`);
        for (const [index, decision] of decisions.entries()) {
          assert(decision?.id && decision?.actor && decision?.decision, 'PROFILE_COMMAND_DECISION_INVALID', `Profile ${profile.id} returned an invalid Decision.`);
          const prior = state.decisions.find(item => item.id === decision.id);
          if (prior) {
            assert(prior.digest === digestJson(decision), 'PROFILE_COMMAND_DECISION_CONFLICT', `Decision ${decision.id} differs from the current Lifecycle Command.`);
            continue;
          }
          state = (await kernel.recordDecision(plan.project.id, state.runId, decision, {
            expectedRevision: state.revision,
            commandId: `${commandId}.profile-decision.${index}`,
          })).state;
        }
        return state;
      };
      const observedLineage = await lineageStore.read(plan.project.id, plan.logicalTaskKey);
      const activationCommandId = `${commandId}.lineage.activate`;
      const priorActivation = observedLineage?.commands?.[activationCommandId];
      if (priorActivation) {
        assert(priorActivation.result.planDigest === plan.planDigest, 'COMMAND_ID_REUSED', 'The lifecycle command ID was reused with a different Lifecycle Plan.');
        let state = await authorityStore.read(plan.project.id, priorActivation.result.activeRunId);
        assert(state.metadata?.lifecyclePlanDigest === plan.planDigest, 'LIFECYCLE_COMMAND_RECEIPT_INVALID', 'The lifecycle command receipt points to a Run bound to another Command Plan.');
        state = await commitCommandDecisions(state);
        if (state.status !== 'closed') {
          const current = resolveRunLineage({ plan, states: await authorityStore.list(plan.project.id), currentLineage: observedLineage, policy: project.policy?.recovery ?? {}, now: kernel.now });
          if (current.action === 'ordinary-resume' && current.selectedRunId === state.runId) {
            const resumed = await kernel.recover(plan.project.id, state.runId, { mode: 'ordinary-resume' }, { expectedRevision: state.revision, commandId: `${commandId}.lineage.resume.${current.resolutionDigest}` });
            state = resumed.state;
          }
        }
        return { status: state.status === 'closed' ? 'closed' : 'started', planDigest: plan.planDigest, plan, runtimePolicy, state, reused: true };
      }
      verifyExecutionReadinessReport(preflightReport, { plan, now: kernel.now });
      const states = await authorityStore.list(plan.project.id);
      const replacedQualityRuns = plan.intent.action === 'quality' && ['repair-known', 'closeout'].includes(plan.intent.preset)
        ? states.filter(candidate => candidate.status !== 'closed' && candidate.status !== 'superseded'
          && candidate.metadata?.commandIntent?.action === 'quality'
          && candidate.metadata.commandIntent.target === plan.intent.target
          && (candidate.metadata?.workflow?.id ?? candidate.metadata.commandIntent.workflowId) === plan.intent.workflowId
          && candidate.metadata.commandIntent.preset !== plan.intent.preset)
        : [];
      for (const candidate of replacedQualityRuns) {
        assert(!candidate.leases.some(lease => lease.status === 'active'), 'QUALITY_MODE_SWITCH_LIVE_LEASE', 'Repair-only quality cannot replace a review Run with an active Agent Lease.', { runId: candidate.runId });
      }
      let lineageResolution;
      try {
        lineageResolution = verifyRunLineageResolution(preflightReport.lineageResolution, { plan, states, currentLineage: observedLineage, now: kernel.now });
      } catch (error) {
        if (error.code !== 'RUN_LINEAGE_RESOLUTION_STALE') throw error;
        lineageResolution = resolveRunLineage({ plan, states, currentLineage: observedLineage, policy: project.policy?.recovery ?? {}, now: kernel.now });
      }
      assert(lineageResolution.action !== 'block', 'RUN_LINEAGE_BLOCKED', 'Lifecycle Plan has no safe automatic Run lineage action.', { blockers: lineageResolution.blockers ?? [] });
      if (plan.intent.action === 'replan') {
        for (const affected of plan.intent.planRevision.affectedImplementationRuns ?? []) {
          const current = await authorityStore.read(plan.project.id, affected.runId);
          if (current.status === 'superseded' && current.metadata?.supersededByRunId === plan.run.runId && current.metadata?.supersedePlanDigest === plan.planDigest) continue;
          assert(current.revision === affected.revision && current.authorityDigest === affected.authorityDigest
            && !current.leases.some(lease => lease.status === 'active')
            && !current.dispatches.some(dispatch => ['requested', 'assigned'].includes(dispatch.status))
            && !current.findings.some(finding => finding.status !== 'resolved'),
          'REPLAN_IMPLEMENTATION_CHANGED', 'Implementation changed or became active after the revision plan was captured.');
          await kernel.supersedeRun(plan.project.id, current.runId, { replacementRunId: plan.run.runId, planDigest: plan.planDigest,
            reason: 'plan-revision-requested' }, { expectedRevision: current.revision, commandId: `${commandId}.replan.supersede.${current.runId}` });
        }
      }
      const selectedRunId = lineageResolution.selectedRunId ?? plan.run.runId;
      const existing = await authorityStore.read(plan.project.id, selectedRunId, { required: false });
      if (existing && existing.status !== 'closed' && existing.metadata?.lifecycleInvocationId && existing.metadata.lifecycleInvocationId !== commandId) {
        return { status: 'attention-required', reason: 'lifecycle-invocation-already-started', planDigest: plan.planDigest, state: existing };
      }
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
           ...(plan.run.metadata?.qualityRepairInventory ? { initialFindings: plan.run.metadata.qualityRepairInventory.findings }
             : plan.run.metadata?.qualityRepairInventories ? { initialFindings: Object.values(plan.run.metadata.qualityRepairInventories).flatMap(inventory => inventory.findings) } : {}),
          profileConfig: plan.run.profileConfig,
          artifactDigest: plan.run.artifactDigest,
          sourceDigest: plan.run.sourceDigest,
          executionWorkspaceRoot: plan.run.executionWorkspaceRoot,
          metadata: { ...(plan.run.metadata ?? {}), logicalTaskKey: plan.logicalTaskKey, lifecyclePlanDigest: plan.planDigest, lifecycleInvocationId: commandId, commandIntent: plan.intent, lifecycleExecution: { runtimePluginId: plan.run.runtimePluginId, agentExecutionMode: plan.run.agentExecutionMode, executionConstraintDigest: plan.run.executionConstraintDigest, executionGrant: plan.run.executionGrant, authorizationSourceDigest: plan.run.sourceDigest, harnessArtifactDigest: plan.harness.artifactDigest, extensionDigest: plan.extension.digest }, stopCondition: plan.stopCondition },
        }, { commandId: `${commandId}.start` });
        state = started.state;
      } else if (lineageResolution.action !== 'return-closed') {
        assert(state.metadata?.lifecyclePlanDigest === plan.planDigest, 'LIFECYCLE_PLAN_RUN_CONFLICT', 'Existing Run is bound to another Command Plan.');
      }
      state = await commitCommandDecisions(state);
      for (const candidate of lineageResolution.candidates) {
        if (candidate.runId === state.runId || candidate.status === 'closed' || candidate.status === 'superseded') continue;
        const current = await authorityStore.read(plan.project.id, candidate.runId);
        if (current.status === 'superseded') continue;
        await kernel.supersedeRun(plan.project.id, candidate.runId, { replacementRunId: state.runId, planDigest: plan.planDigest, reason: lineageResolution.reasonCode }, { expectedRevision: current.revision, commandId: `${commandId}.lineage.supersede.${candidate.runId}.${lineageResolution.resolutionDigest}` });
      }
      for (const candidate of replacedQualityRuns) {
        if (candidate.runId === state.runId) continue;
        const current = await authorityStore.read(plan.project.id, candidate.runId);
        if (current.status === 'closed' || current.status === 'superseded') continue;
        assert(!current.leases.some(lease => lease.status === 'active'), 'QUALITY_MODE_SWITCH_LIVE_LEASE', 'Repair-only quality cannot replace a review Run with an active Agent Lease.', { runId: current.runId });
        await kernel.supersedeRun(plan.project.id, current.runId, { replacementRunId: state.runId, planDigest: plan.planDigest, reason: 'quality-mode-switch-to-repair-known' }, { expectedRevision: current.revision, commandId: `${commandId}.quality-mode-switch.${current.runId}` });
      }
      const currentLineage = await lineageStore.read(plan.project.id, plan.logicalTaskKey);
      await lineageStore.activate({ projectId: plan.project.id, logicalTaskKey: plan.logicalTaskKey, activeRunId: state.runId, planDigest: plan.planDigest, resolutionDigest: lineageResolution.resolutionDigest }, { expectedRevision: currentLineage?.revision ?? 0, commandId: activationCommandId });
      return { status: state.status === 'closed' ? 'closed' : 'started', planDigest: plan.planDigest, plan, runtimePolicy, state, lineageResolution, reused: false };
    },

    async executeLifecyclePlan(planInput, options) {
      return executeHeadlessLifecyclePlan(serviceContext, api, planInput, options);
    },

    async invokeGateExecutor(pluginId, spec, options = {}) {
      assertIssuedGateInvocation(spec);
      pluginHost.get(pluginId, 'gate-executor');
      return pluginHost.invoke(pluginId, 'execute', spec, options);
    },

    async recordVerifiedGate(projectId, runId, input, command) {
      assertIssuedGateSubmission(input);
      return kernel.recordGate(projectId, runId, input, command);
    },

    async executeVisibleLifecyclePlan(planInput, options) {
      return runVisibleLifecyclePlan(serviceContext, api, planInput, options);
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
      if (!['interrupt', 'cleanup', 'discard'].includes(method)) await assertWorkspaceRunAccess(state, dispatch.runtimePluginId);
      const manifest = pluginHost.get(dispatch.runtimePluginId, 'agent-runtime').manifest;
      const action = state.metadata?.commandIntent?.action;
      const runtimePolicy = assertAgentRuntimeCompatible({ project, manifest, action, workflowId: state.metadata?.workflow?.id, runtimePluginId: dispatch.runtimePluginId, agentExecutionMode: dispatch.execution?.runtime?.mode });
      assert(runtimePolicy.mode === 'headless', 'VISIBLE_AGENT_HOST_REQUIRED', 'Conversation-visible Agents must be controlled by the interactive host, not through Runtime plugin invocation.');
      if (!['interrupt', 'cleanup', 'discard'].includes(method)) await verifyRunExecutionAuthorization({ project, state, manifest });
      return pluginHost.invoke(dispatch.runtimePluginId, method, { agentId: lease.agentId, ...structuredClone(input) });
    },

    async assertRunExecutionAuthorized(projectId, runId) {
      const [project, state] = await Promise.all([projectRegistry.get(projectId), authorityStore.read(projectId, runId)]);
      const runtimePluginId = state.metadata?.lifecycleExecution?.runtimePluginId ?? resolveLifecycleExecutionPolicy({ project, action: state.metadata?.commandIntent?.action, workflowId: state.metadata?.workflow?.id }).runtimePluginId;
      await assertWorkspaceRunAccess(state, runtimePluginId);
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
      const runSourceDigest = input.sourceDigest ?? snapshot.digest;
      let approvedPlan = null;
      if (input.metadata?.commandIntent?.action === 'implement' && input.features.some(feature => feature.metadata?.stage === 'implementation') && !input.features.some(feature => feature.metadata?.stage === 'plan-review')) {
        const target = input.metadata?.commandIntent?.target;
        const workflowId = input.metadata?.workflow?.id;
        const projectRuns = await authorityStore.list(project.id);
        const candidates = projectRuns.filter(run => run.status !== 'superseded'
          && run.metadata?.commandIntent?.target === target && run.metadata?.workflow?.id === workflowId
          && run.features.some(feature => feature.metadata?.stage === 'plan-review'));
        const planKey = candidates.find(run => run.metadata?.logicalTaskKey)?.metadata.logicalTaskKey;
        const activePlanLineage = planKey ? await lineageStore.read(project.id, planKey) : null;
        const latest = activePlanLineage ? candidates.find(run => run.runId === activePlanLineage.activeRunId)
          : candidates.find(run => !run.metadata?.logicalTaskKey && run.status === 'closed');
        assert(latest?.status === 'closed', 'IMPLEMENTATION_PLAN_CURRENT_REVISION_REQUIRED', 'Implementation requires the active plan revision to be closed and approved.');
        assert(latest && planApprovalSatisfied(latest), 'IMPLEMENTATION_PLAN_USER_APPROVAL_REQUIRED', 'Implementation requires a current, user-approved Markdown plan for this project, target, workflow, and source.');
        const artifact = await ensurePlanApprovalArtifact(authorityStore.root, latest);
        let sourceCompatibility = null;
        if (latest.sourceDigest !== runSourceDigest) {
          const current = snapshot ?? await captureWorkspace(workspace.root, { excluded: project.workspace.excluded ?? [] });
          assert(current.digest === runSourceDigest, 'IMPLEMENTATION_PLAN_SOURCE_MISMATCH', 'Implementation source digest does not match the current project workspace.');
          const sourceRef = latest.dispatches.findLast(dispatch => dispatch.sourceDigest === latest.sourceDigest && dispatch.sourceSnapshotRef)?.sourceSnapshotRef;
          assert(sourceRef, 'IMPLEMENTATION_PLAN_SOURCE_EVIDENCE_REQUIRED', 'Approved plan has no source snapshot evidence for drift assessment.');
          const evidence = await evidenceStore.read(sourceRef);
          assert(evidence.metadata.projectId === project.id && evidence.metadata.runId === latest.runId, 'IMPLEMENTATION_PLAN_SOURCE_EVIDENCE_MISMATCH', 'Plan source evidence belongs to another Run.');
          const assessment = assessPlanSourceCompatibility({ planRun: latest, baselineSnapshot: JSON.parse(evidence.bytes.toString('utf8')), currentSnapshot: current, excluded: project.workspace.excluded ?? [] });
          const reviewedDecision = matchingPlanSourceCompatibilityDecision(latest, assessment);
          if (reviewedDecision) {
            sourceCompatibility = { mode: 'reviewed-decision', decisionId: reviewedDecision.id, changedFilesDigest: assessment.changedFilesDigest };
          } else {
            sourceCompatibility = assessVerifiedImplementationContinuation({ planRun: latest, planArtifact: artifact,
              priorRuns: projectRuns, currentSourceDigest: runSourceDigest, workspaceRoot: workspace.root,
              implementationFeatures: input.features })
              ?? await assessRecoveredImplementationContinuation({ planRun: latest, planArtifact: artifact,
                priorRuns: projectRuns, currentSnapshot: current, workspaceRoot: workspace.root,
                implementationFeatures: input.features,
                evidenceStore, controlRoot, dataRoot: globalDataRoot })
              ?? assessAutomaticPlanSourceCompatibility({ planRun: latest, assessment,
                implementationFeatures: input.features, policyPaths: project.policy?.planSourceAutoCompatiblePaths ?? [] });
            assert(sourceCompatibility, 'IMPLEMENTATION_PLAN_SOURCE_MISMATCH', 'Approved plan source changed outside the configured automatic compatibility paths or approved implementation scope.', { changedFiles: assessment.changedFiles });
          }
        }
        const typedPlan = reviewedPlanProposal(latest);
        assert(typedPlan?.proposedFeatures?.some(feature => feature.projectId === project.id && feature.disposition === 'project-owned'),
          'IMPLEMENTATION_TYPED_PLAN_REQUIRED', 'Approved implementation plan has no project-owned Feature proposal.');
        approvedPlan = { projectId: latest.projectId, runId: latest.runId, planDigest: artifact.planDigest, artifactDigest: artifact.artifactDigest, sourceDigest: runSourceDigest, originalSourceDigest: latest.sourceDigest, typedPlan: structuredClone(typedPlan), ...(sourceCompatibility ? { sourceCompatibility } : {}) };
      }
      const pluginSet = pluginHost.snapshot();
      const installedCompositionDigest = digestJson({ plugins: pluginSet.manifests, extensions: extensionSet.installed });
      const policyDigest = input.policyDigest ?? digestJson({ profiles: project.profiles, extensions: project.extensions ?? [], ...(project.workflows ? { workflows: project.workflows } : {}), policy: project.policy ?? {}, gateRecipes: project.gateRecipes ?? [], artifactProviders: project.artifactProviders ?? [] });
      const commandIntent = input.metadata?.commandIntent ?? null;
      const commandAction = commandIntent?.action;
      const executionPolicy = resolveLifecycleExecutionPolicy({ project, action: commandAction, workflowId: commandIntent?.workflowId });
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
      const implementationFeature = input.features.find(feature => feature.metadata?.stage === 'implementation');
      const features = approvedPlan && implementationFeature?.task && implementationFeature.metadata?.workflow?.nodeId === 'implement'
        ? expandApprovedImplementation({ features: input.features, typedPlan: approvedPlan.typedPlan, projectId: project.id })
        : approvedPlan ? input.features.map(feature => feature.metadata?.stage === 'implementation'
          ? { ...feature, attemptLimit: Math.max(feature.attemptLimit ?? 3, 21),
            metadata: { ...feature.metadata, approvedDeliveryPlan: structuredClone(approvedPlan.typedPlan), implementationProgressRetries: 20 } }
          : feature) : input.features;
      return kernel.startRun({ ...input, features, profileConfig, policyDigest, sourceDigest: runSourceDigest, pluginSetDigest: input.pluginSetDigest ?? installedCompositionDigest, metadata: { ...input.metadata, approvedPlan, ...(lifecycleExecution ? { lifecycleExecution } : {}), workspace: structuredClone(workspace), gateRecipes: structuredClone(project.gateRecipes ?? []), projectDescriptorDigest: project.descriptorDigest, extensionSetDigest: extensionSet.digest } }, command);
    },

    async dispatch(projectId, runId, input, command) {
      const state = await authorityStore.read(projectId, runId);
      if (state.metadata?.sourceManifest) await assertSourceManifestCurrent(state.metadata.sourceManifest);
      if (state.metadata?.logicalTaskKey) await lineageStore.assertActive(projectId, state.metadata.logicalTaskKey, runId);
      assert(state.revision === command.expectedRevision, 'REVISION_CONFLICT', 'Authority revision changed before scheduling.', { expected: command.expectedRevision, actual: state.revision });
      const project = await projectRegistry.get(projectId);
      const workspaceRoot = state.metadata?.workspace?.root ?? project.workspace.root;
      const action = state.metadata?.commandIntent?.action;
      const selectedPolicy = resolveLifecycleExecutionPolicy({ project, action, workflowId: state.metadata?.workflow?.id });
      const runtimePluginId = input.runtimePluginId ?? state.metadata?.lifecycleExecution?.runtimePluginId ?? selectedPolicy.runtimePluginId;
      await assertWorkspaceRunAccess(state, runtimePluginId);
      assert(runtimePluginId, 'DEFAULT_RUNTIME_REQUIRED', `Project ${projectId} requires an explicit default Runtime.`);
      let runtimeManifest = null;
      let runtimePolicy = null;
      if (runtimePluginId) {
        assert((project.policy?.runtimePlugins ?? [runtimePluginId]).includes(runtimePluginId), 'PROJECT_RUNTIME_DENIED', `Runtime ${runtimePluginId} is not allowed by Project ${projectId}.`);
        runtimeManifest = pluginHost.get(runtimePluginId, 'agent-runtime').manifest;
        runtimePolicy = assertAgentRuntimeCompatible({ project, manifest: runtimeManifest, action, workflowId: state.metadata?.workflow?.id, runtimePluginId, agentExecutionMode: state.metadata?.lifecycleExecution?.agentExecutionMode ?? selectedPolicy.mode });
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
      const snapshotEvidence = await evidenceStore.put(snapshot, { mediaType: 'application/json', projectId, ...(state.metadata?.workspaceRef ? { workspaceRef: state.metadata.workspaceRef } : {}), runId, epoch: state.epoch, generation: state.generation, sourceDigest: state.sourceDigest, artifactDigest: state.artifactDigest, policyDigest: state.policyDigest, pluginSetDigest: state.pluginSetDigest, labels: ['workspace-snapshot'] });
      const visibleHeartbeatTimeoutMs = Number(project.policy?.visibleHeartbeatTimeoutMs ?? 120000);
      if (runtimePolicy.mode === 'conversation-visible') assert(Number.isFinite(visibleHeartbeatTimeoutMs) && visibleHeartbeatTimeoutMs > 0, 'VISIBLE_AGENT_HEARTBEAT_TIMEOUT_INVALID', 'Visible Agent heartbeat timeout must be a positive number of milliseconds.');
      const scheduledInput = { ...input, maxConcurrency: schedulingLimit, runtimePluginId, runtimeRequirements: { mode: runtimePolicy.mode, userVisible: runtimePolicy.userVisible, hostOrchestrated: runtimePolicy.hostOrchestrated, ...(runtimePolicy.mode === 'conversation-visible' ? { heartbeatTimeoutMs: visibleHeartbeatTimeoutMs } : {}) }, sourceSnapshotRef: snapshotEvidence.ref };
      if (input.candidateFeatureIds) {
        const executionByFeatureId = Object.fromEntries(input.candidateFeatureIds.map(featureId => {
          const feature = state.features.find(item => item.id === featureId);
          assert(feature, 'FEATURE_NOT_FOUND', `Unknown candidate Feature: ${featureId}`);
          return [featureId, { prompt: structuredClone(promptBinding), result: createDispatchResultContract(feature, { conversationVisible: runtimePolicy.mode === 'conversation-visible' }), runtime: { mode: runtimePolicy.mode, userVisible: runtimePolicy.userVisible, hostOrchestrated: runtimePolicy.hostOrchestrated, ...(runtimeManifest.capabilities.includes('typed-output-envelope-v1') ? { resultDialect: 'typed-output-envelope-v1' } : {}) } }];
        }));
        return kernel.schedule(projectId, runId, { ...scheduledInput, executionByFeatureId }, command);
      }
      const activeFeatureIds = [...new Set([...state.leases.filter(lease => ['requested', 'active'].includes(lease.status)).map(lease => lease.featureId), ...state.dispatches.filter(dispatch => ['requested', 'assigned'].includes(dispatch.status)).map(dispatch => dispatch.featureId)])];
      const featureGateIds = new Set((state.metadata?.gateRecipes ?? []).filter(recipe => recipe.scope === 'feature').map(recipe => recipe.id));
      const deniedFeatureIds = state.features.filter(feature => feature.dependsOn.some(id => {
        const dependency = state.features.find(item => item.id === id);
        return dependency?.gatePlan.some(gateId => featureGateIds.has(gateId) && !state.gates.some(gate => gate.id === gateId && gate.scope === 'feature' && gate.featureId === id && gate.status === 'passed' && gate.sourceDigest === state.sourceDigest));
      })).map(feature => feature.id);
      const strategy = await pluginHost.invoke(input.schedulerPluginId ?? manifests.scheduler.id, 'select', { revision: state.revision, features: state.features, activeFeatureIds, limit: schedulingLimit, deniedFeatureIds });
      const executionByFeatureId = {};
      const modelRouterPluginId = input.modelRouterPluginId ?? project.policy?.modelRouterPlugin ?? null;
      const toolBrokerPluginId = input.toolBrokerPluginId ?? project.policy?.toolBrokerPlugin ?? null;
      if (toolBrokerPluginId) pluginHost.get(toolBrokerPluginId, 'tool-broker');
      for (const featureId of strategy.payload.featureIds) {
        const feature = state.features.find(item => item.id === featureId);
        const execution = { prompt: structuredClone(promptBinding), result: createDispatchResultContract(feature, { conversationVisible: runtimePolicy.mode === 'conversation-visible' }), ...(runtimePolicy ? { runtime: { mode: runtimePolicy.mode, userVisible: runtimePolicy.userVisible, hostOrchestrated: runtimePolicy.hostOrchestrated, ...(runtimeManifest.capabilities.includes('typed-output-envelope-v1') ? { resultDialect: 'typed-output-envelope-v1' } : {}) } } : {}) };
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
      const runtimePolicy = assertAgentRuntimeCompatible({ project, manifest, action: state.metadata?.commandIntent?.action, workflowId: state.metadata?.workflow?.id, runtimePluginId, agentExecutionMode: dispatch.execution?.runtime?.mode });
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
      const runtimePolicy = assertRuntimeTransportReceipt({ project, manifest, receipt: input.runtimeReceipt, action: state.metadata?.commandIntent?.action, workflowId: state.metadata?.workflow?.id, runtimePluginId: dispatch.runtimePluginId, agentExecutionMode: dispatch.execution?.runtime?.mode });
      const trustedAgentAdapter = resolveVisibleHostAdapter(dispatch.runtimePluginId);
      let runtimeReceipt = structuredClone(input.runtimeReceipt);
      if (runtimePolicy.mode === 'conversation-visible') {
        assert(!Object.hasOwn(runtimeReceipt, 'hostAttestation'), 'VISIBLE_AGENT_HOST_ATTESTATION_UNTRUSTED', 'Visible Runtime Receipt cannot supply its own host attestation.');
        const { prompt } = await compileDispatchPrompt(state, dispatch);
        assert(runtimeReceipt.agentId === input.agentId, 'RUNTIME_RECEIPT_AGENT_MISMATCH', 'Runtime Receipt Agent identity does not match the requested Lease binding.');
        assert(runtimeReceipt.dispatchId === dispatch.dispatchId, 'RUNTIME_RECEIPT_DISPATCH_MISMATCH', 'Runtime Receipt Dispatch identity does not match the managed Dispatch.');
        assert(runtimeReceipt.packetDigest === dispatch.packetDigest, 'PACKET_DIGEST_MISMATCH', 'Runtime Receipt does not match the immutable Dispatch packet.');
        if (dispatch.execution?.prompt?.contractVersion === AGENT_PROMPT_CONTRACT_VERSION) assert(runtimeReceipt.resultContractDigest === dispatch.execution?.result?.contractDigest, 'RESULT_CONTRACT_RECEIPT_MISMATCH', 'Visible Runtime Receipt does not match the immutable Dispatch result contract.');
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
      const trustedAgentAdapter = resolveVisibleHostAdapter(dispatch.runtimePluginId);
      if (dispatch.execution?.runtime?.mode === 'conversation-visible') {
        assertVisibleHostReceiptOwner(trustedAgentAdapter, lease.runtimeReceipt);
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
      if (dispatch.execution?.result) assertDispatchResultContract(dispatch.execution.result, feature, { conversationVisible });
      const validatedResult = validateBusinessResult(result, { conversationVisible, repair: Boolean(feature?.metadata?.repairFindingId), feature });
      validateProfileResult({ profile: profileRegistry.get(state.profile.id), state, feature, result: validatedResult });
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
      const rejection = runtimeEvidence?.resultRejection;
      if (rejection) {
        const { receiptDigest, ...rejectionBody } = rejection;
        assert(validatedResult.status === 'failed' && validatedResult.failureClass === 'runtime-contract' && rejection.kind === 'result-rejected-receipt' && rejection.version === '1.0' && receiptDigest === digestJson(rejectionBody), 'RESULT_REJECTION_RECEIPT_INVALID', 'Host result rejection is not a valid failed-result receipt.');
        assert(rejection.agentId === lease.agentId && rejection.dispatchId === dispatchId && rejection.packetDigest === dispatch.packetDigest && rejection.resultContractDigest === dispatch.execution?.result?.contractDigest && rejection.promptDigest === lease.runtimeReceipt?.prompt?.promptDigest && runtimeEvidence.hostResultReceipt?.rejectionDigest === receiptDigest, 'RESULT_REJECTION_RECEIPT_BINDING_MISMATCH', 'Host result rejection is not bound to this Lease, Dispatch, result contract, and Host observation.');
      } else {
        assert(digestJson(claimedChangedFiles) === digestJson(actualChangedFiles), 'RESULT_CHANGED_FILES_MISMATCH', 'Runtime changed-files claim does not match the workspace snapshot diff.', { claimedChangedFiles, actualChangedFiles });
      }
      const verifiedResult = { ...validatedResult, changedFiles: actualChangedFiles };
      await atomicWriteJson(dispatch.outputRef, verifiedResult, { root: authorityStore.root });
      const preservedRuntimeEvidence = runtimeEvidence ? JSON.parse(JSON.stringify(runtimeEvidence)) : null;
      const evidence = await evidenceStore.put({ result: verifiedResult, runtimeEvidence: preservedRuntimeEvidence, inputSourceDigest: dispatch.sourceDigest, outputSourceDigest: resultingSnapshot.digest, sourceSnapshotRef: dispatch.sourceSnapshotRef }, { ...evidenceMetadata, mediaType: 'application/json', projectId, ...(state.metadata?.workspaceRef ? { workspaceRef: state.metadata.workspaceRef } : {}), runId, epoch: state.epoch, generation: state.generation, featureId: dispatch.featureId, dispatchId, sourceDigest: dispatch.sourceDigest, artifactDigest: state.artifactDigest, policyDigest: state.policyDigest, pluginSetDigest: state.pluginSetDigest, labels: ['agent-result'] });
      const submitted = await kernel.submit(projectId, runId, { dispatchId, outputRef: dispatch.outputRef, agentId: lease.agentId, packetDigest: dispatch.packetDigest, epoch: state.epoch, generation: state.generation, result: verifiedResult, resultingSourceDigest: resultingSnapshot.digest, evidenceRefs: [evidence.ref] }, { expectedRevision: state.revision, commandId });
      if (feature?.metadata?.stage === 'plan-review' && verifiedResult.status === 'completed') await ensurePlanApprovalArtifact(authorityStore.root, submitted.state);
      return submitted;
    },

    async status(projectId, runId) {
      const state = await authorityStore.read(projectId, runId);
      const planReview = planApprovalSnapshot(state);
      return { authority: state, projection: profileRegistry.get(state.profile.id).project(state), ...(planReview ? { planApproval: { planDigest: planReview.planDigest, artifactDigest: planReview.artifactDigest, approved: planApprovalSatisfied(state) } } : {}) };
    },
  };
  return api;
};
