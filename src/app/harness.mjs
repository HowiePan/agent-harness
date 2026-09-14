import { resolve } from 'node:path';
import { atomicWriteJson } from '../kernel/atomic-io.mjs';
import { AuthorityStore } from '../kernel/authority-store.mjs';
import { EvidenceStore } from '../kernel/evidence-store.mjs';
import { buildDispatchPacket, HarnessKernel } from '../kernel/kernel.mjs';
import { digestJson } from '../canonical.mjs';
import { assert } from '../errors.mjs';
import { PluginHost } from '../plugins/host.mjs';
import { createConflictScheduler } from '../plugins/scheduler/conflict-scheduler.mjs';
import { createJsonCodec } from '../plugins/codec/json-codec.mjs';
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
import { ProjectGateRunner } from '../gates/project-gate-runner.mjs';

export const defaultDataRoot = (controlRoot = harnessControlRoot()) => resolve(controlRoot, '.agent-harness-data');

const manifests = Object.freeze({
  scheduler: { id: 'reference-conflict-scheduler', kind: 'scheduler', version: '1.0.0', capabilities: ['feature-dag', 'conflict-graph', 'lane-fairness'], permissions: [] },
  codec: { id: 'reference-json-codec', kind: 'codec', version: '1.0.0', capabilities: ['json', 'structured-result'], permissions: [] },
  model: { id: 'reference-static-model-router', kind: 'model-router', version: '1.0.0', capabilities: ['capability-route', 'risk-route'], permissions: [] },
  storage: { id: 'reference-file-storage', kind: 'storage-provider', version: '1.0.0', capabilities: ['expected-revision', 'idempotency', 'atomic-write', 'recovery'], permissions: ['state.write'] },
});

export const createHarness = async ({ controlRoot: controlRootInput, dataRoot: dataRootInput, now, id, releaseIdentity, strictProjectIdentity = true, initializeStorage = true, allowedPluginPermissions = ['state.write', 'agent.conversation', 'process.spawn', 'workspace.read', 'workspace.write', 'gate.execute', 'artifact.read'], extraProfiles = [], extensions = [] } = {}) => {
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
  const profileRegistry = new ProfileRegistry([featureDeliveryProfile, ...extraProfiles]);
  const pluginHost = new PluginHost({ allowedPermissions: allowedPluginPermissions });
  pluginHost.register(manifests.scheduler, createConflictScheduler({ manifest: manifests.scheduler }));
  pluginHost.register(manifests.codec, createJsonCodec({ manifest: manifests.codec }));
  pluginHost.register(manifests.model, createStaticModelRouter({ manifest: manifests.model, routes: [] }));
  pluginHost.register(manifests.storage, createAuthorityStoragePlugin({ manifest: manifests.storage, store: authorityStore }));
  const projectRegistry = new ProjectRegistry({ root: authorityStore.root, controlRoot, now, strictIdentity: strictProjectIdentity });
  const extensionSet = await installExtensionPacks(extensions, {
    profileRegistry,
    pluginHost,
    factoryContext: { controlRoot, dataRoot: authorityStore.root, resolveProject: projectId => projectRegistry.get(projectId), now },
    requireVerifiedArtifacts: strictProjectIdentity,
  });
  const kernel = new HarnessKernel({ authorityStore, evidenceStore, profiles: profileRegistry, now, id });
  const recovery = new RecoveryCoordinator({ kernel, importers: extensionSet.recoveryImporters, controlRoot });
  const extensionPacks = new Map(extensions.map(extension => [extension.id, extension]));

  const api = {
    dataRoot: authorityStore.root,
    controlRoot,
    authorityStore,
    evidenceStore,
    profileRegistry,
    pluginHost,
    projectRegistry,
    kernel,
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
      return plan;
    },

    async executeLifecyclePlan(planInput, { commandId, maxConcurrency = 1, maxRounds = 100, forceFreshGates = true } = {}) {
      assert(commandId, 'COMMAND_ID_REQUIRED', 'Lifecycle execution requires a command ID.');
      const plan = validateLifecycleCommandPlan(planInput);
      const project = await projectRegistry.get(plan.project.id);
      assert(project.revision === plan.project.revision && project.descriptorDigest === plan.project.descriptorDigest, 'LIFECYCLE_PLAN_PROJECT_STALE', 'Lifecycle Command Plan is stale for the current Project Descriptor.');
      assert(currentReleaseIdentity.artifactDigest === plan.harness.artifactDigest && currentReleaseIdentity.version === plan.harness.version, 'LIFECYCLE_PLAN_RELEASE_STALE', 'Lifecycle Command Plan is stale for the active Harness release.');
      const existing = await authorityStore.read(plan.project.id, plan.run.runId, { required: false });
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
      if (state.status === 'closed') return { status: 'closed', planDigest: plan.planDigest, state };
      assert(state.status !== 'superseded', 'LIFECYCLE_PLAN_RUN_SUPERSEDED', 'Lifecycle execution cannot resume a superseded Run.');
      const coordinator = new RunCoordinator({ harness: api });
      const execution = await coordinator.run({ projectId: plan.project.id, runId: plan.run.runId, runtimePluginId: plan.run.runtimePluginId, maxConcurrency, maxRounds });
      state = await authorityStore.read(plan.project.id, plan.run.runId);
      if (!state.features.every(feature => feature.state === 'completed')) return { status: execution.status, planDigest: plan.planDigest, execution, state };
      const gateRunner = new ProjectGateRunner({ harness: api });
      const gates = await gateRunner.run({ projectId: plan.project.id, runId: plan.run.runId, scope: 'final', forceFresh: forceFreshGates, gateIds: plan.stopCondition.requiredFinalGates ?? [] });
      state = await authorityStore.read(plan.project.id, plan.run.runId);
      const closed = await api.kernel.closeRun(plan.project.id, plan.run.runId, {}, { expectedRevision: state.revision, commandId: `${commandId}.close` });
      return { status: 'closed', planDigest: plan.planDigest, execution, gates, state: closed.state };
    },

    registerPlugin(manifest, instance) { return pluginHost.register(manifest, instance); },

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
      if (runtimePluginId) {
        assert((project.policy?.runtimePlugins ?? [runtimePluginId]).includes(runtimePluginId), 'PROJECT_RUNTIME_DENIED', `Runtime ${runtimePluginId} is not allowed by Project ${projectId}.`);
        pluginHost.get(runtimePluginId, 'agent-runtime');
      }
      const snapshot = await captureWorkspace(workspaceRoot, { excluded: project.workspace.excluded ?? [] });
      assert(snapshot.digest === state.sourceDigest, 'WORKSPACE_SOURCE_DRIFT', 'Workspace changed outside a committed Feature result.', { authoritySourceDigest: state.sourceDigest, workspaceSourceDigest: snapshot.digest });
      const snapshotEvidence = await evidenceStore.put(snapshot, { mediaType: 'application/json', projectId, runId, epoch: state.epoch, generation: state.generation, sourceDigest: state.sourceDigest, artifactDigest: state.artifactDigest, policyDigest: state.policyDigest, pluginSetDigest: state.pluginSetDigest, labels: ['workspace-snapshot'] });
      const scheduledInput = { ...input, runtimePluginId, sourceSnapshotRef: snapshotEvidence.ref };
      if (input.candidateFeatureIds) return kernel.schedule(projectId, runId, scheduledInput, command);
      const activeFeatureIds = [...new Set([...state.leases.filter(lease => ['requested', 'active'].includes(lease.status)).map(lease => lease.featureId), ...state.dispatches.filter(dispatch => ['requested', 'assigned'].includes(dispatch.status)).map(dispatch => dispatch.featureId)])];
      const strategy = await pluginHost.invoke(input.schedulerPluginId ?? manifests.scheduler.id, 'select', { revision: state.revision, features: state.features, activeFeatureIds, limit: Number(input.maxConcurrency ?? 1), deniedFeatureIds: [] });
      const executionByFeatureId = {};
      const modelRouterPluginId = input.modelRouterPluginId ?? project.policy?.modelRouterPlugin ?? null;
      const toolBrokerPluginId = input.toolBrokerPluginId ?? project.policy?.toolBrokerPlugin ?? null;
      if (toolBrokerPluginId) pluginHost.get(toolBrokerPluginId, 'tool-broker');
      for (const featureId of strategy.payload.featureIds) {
        const feature = state.features.find(item => item.id === featureId);
        const execution = {};
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
      const dispatch = state.dispatches.find(item => item.dispatchId === dispatchId);
      assert(dispatch?.status === 'requested', 'DISPATCH_NOT_SPAWNABLE', `Dispatch is not awaiting a Runtime: ${dispatchId}`);
      const feature = dispatch.featureSnapshot ?? state.features.find(item => item.id === dispatch.featureId);
      const packet = buildDispatchPacket(state, dispatch, feature);
      assert(digestJson(packet) === dispatch.packetDigest, 'PACKET_DIGEST_MISMATCH', 'Persisted Dispatch no longer matches its packet.');
      const runtime = await pluginHost.invoke(runtimePluginId, 'spawn', packet);
      const payload = runtime.payload;
      const bound = await kernel.bindLease(projectId, runId, { dispatchId, agentId: payload.agentId, packetDigest: dispatch.packetDigest, runtimeReceipt: payload.transportReceipt }, { expectedRevision: state.revision, commandId });
      return { packet, runtimeReceipt: runtime, lease: bound.result.lease, state: bound.state };
    },

    async recordResult(projectId, runId, dispatchId, result, { commandId, evidenceMetadata = {}, runtimeEvidence = null }) {
      const state = await authorityStore.read(projectId, runId);
      const dispatch = state.dispatches.find(item => item.dispatchId === dispatchId);
      const lease = state.leases.find(item => item.dispatchId === dispatchId && item.status === 'active');
      assert(dispatch && lease, 'ACTIVE_LEASE_REQUIRED', `Dispatch does not have an active Lease: ${dispatchId}`);
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
