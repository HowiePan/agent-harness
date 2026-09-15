import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHarness } from '../src/app/harness.mjs';
import { loadExtensionPack } from '../src/extensions/contract.mjs';
import { createCardWorldProjectDescriptor } from '../src/consumers/cardworld-engine.mjs';
import { createReleaseActivationPlan, applyReleaseActivationPlan } from '../src/maintenance/release-activation.mjs';
import { ExtensionRegistry } from '../src/extensions/registry.mjs';
import { ProjectRegistry } from '../src/registry/project-registry.mjs';
import { loadReleaseIdentity } from '../src/release-identity.mjs';
import { activeReleaseFile } from '../src/registry/active-generation.mjs';
import { harnessTemporaryRoot } from '../src/write-boundary.mjs';
import { createTestExecutionAuthorizationAdapter } from './test-support.mjs';
import { projectExecutionPolicyDecisionContext } from '../src/registry/project-registry.mjs';

const releaseIdentity = { version: '1.0.0', artifactDigest: 'a'.repeat(64), verified: true };

test('lifecycle planning deterministically composes quality/full without conversational approvals', async t => {
  const controlRoot = resolve(process.cwd());
  const tempParent = resolve(harnessTemporaryRoot(), 'lifecycle-command-tests');
  await mkdir(tempParent, { recursive: true });
  const root = await mkdtemp(resolve(tempParent, 'plan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = resolve(root, 'CardWorld');
  const dataRoot = resolve(root, 'data');
  await mkdir(resolve(workspaceRoot, '.git'), { recursive: true });
  await writeFile(resolve(workspaceRoot, 'README.md'), 'fixture\n', 'utf8');
  const extension = await loadExtensionPack('./src/consumers/cardworld-engine.mjs', { cwd: controlRoot, controlRoot });
  const runtimeExtension = await loadExtensionPack('./src/extensions/codex-runtime.mjs', { cwd: controlRoot, controlRoot });
  const harness = await createHarness({ controlRoot, dataRoot, releaseIdentity, strictProjectIdentity: false, extensions: [extension, runtimeExtension] });
  const descriptor = createCardWorldProjectDescriptor({ workspaceRoot, harness: releaseIdentity });
  descriptor.extensions = descriptor.extensions.map(item => ({ ...item, digest: item.id === extension.id ? extension.digest : runtimeExtension.digest }));
  await harness.projectRegistry.register(descriptor, { expectedRevision: 0, commandId: 'plan-project-register' });
  const first = await harness.createLifecyclePlan({ projectId: descriptor.id, action: 'quality', target: 'V3.8.4', arguments: ['full'], extensionId: extension.id, executionWorkspaceRoot: workspaceRoot });
  const second = await harness.createLifecyclePlan({ projectId: descriptor.id, action: 'quality', target: 'V3.8.4', arguments: ['full'], extensionId: extension.id, executionWorkspaceRoot: workspaceRoot });
  assert.equal(first.planDigest, second.planDigest);
  assert.equal(first.run.profileConfig.requireCanonicalDecision, false);
  assert.equal(first.run.profileConfig.requireUserCodeReview, false);
  assert.equal(first.run.features.length, 1);
  assert.equal(first.run.features[0].metadata.stage, 'quality');
  assert.equal(first.run.runtimePluginId, 'codex-conversation-runtime');
  assert.equal(first.stopCondition.type, 'quality-run-complete');
  assert.equal(first.protectedOperations.includes('hard-recovery'), false);
  assert.equal(first.protectedOperations.includes('external-cutover'), true);
  const preflight = await harness.createExecutionReadinessReport(first);
  assert.equal(preflight.executionReady, false);
  assert.equal(preflight.checks.find(check => check.id === 'visible-host').issues[0].code, 'VISIBLE_AGENT_HOST_COORDINATOR_UNAVAILABLE');
  const gateIssueCodes = preflight.checks.find(check => check.id === 'gates').issues.map(issue => issue.code);
  assert.equal(gateIssueCodes.includes('PROCESS_PROGRESS_OBSERVER_REQUIRED'), true);
  assert.equal(preflight.checks.find(check => check.id === 'write-capability').ready, true);
  await assert.rejects(
    () => harness.startLifecyclePlan(first, { commandId: 'visible-lifecycle', preflightReport: preflight }),
    error => error.code === 'EXECUTION_NOT_READY',
  );
  assert.equal(await harness.authorityStore.read(descriptor.id, first.run.runId, { required: false }), null);
});

test('headless quality requires one trusted command grant while other Engine actions stay visible', async t => {
  const controlRoot = resolve(process.cwd());
  const tempParent = resolve(harnessTemporaryRoot(), 'lifecycle-command-tests');
  await mkdir(tempParent, { recursive: true });
  const root = await mkdtemp(resolve(tempParent, 'scoped-headless-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = resolve(root, 'CardWorld');
  const dataRoot = resolve(root, 'data');
  await mkdir(resolve(workspaceRoot, '.git'), { recursive: true });
  await writeFile(resolve(workspaceRoot, 'README.md'), 'fixture\n', 'utf8');
  const extension = await loadExtensionPack('./src/consumers/cardworld-engine.mjs', { cwd: controlRoot, controlRoot });
  const runtimeExtension = await loadExtensionPack('./src/extensions/codex-runtime.mjs', { cwd: controlRoot, controlRoot });
  const headlessExtension = await loadExtensionPack('./src/extensions/codex-headless-runtime.mjs', { cwd: controlRoot, controlRoot });
  const descriptor = createCardWorldProjectDescriptor({ workspaceRoot, harness: releaseIdentity, runtimePluginIds: ['codex-conversation-runtime', 'codex-cli-runtime'], actionExecution: { quality: { agentExecutionMode: 'headless', runtimePluginId: 'codex-cli-runtime' } } });
  descriptor.gateRecipes = [];
  descriptor.extensions = descriptor.extensions.map(item => ({ ...item, digest: item.id === extension.id ? extension.digest : item.id === runtimeExtension.id ? runtimeExtension.digest : headlessExtension.digest }));
  const harness = await createHarness({ controlRoot, dataRoot, releaseIdentity, strictProjectIdentity: false, extensions: [extension, runtimeExtension, headlessExtension], executionAuthorizationAdapter: createTestExecutionAuthorizationAdapter(), allowedPluginPermissions: ['state.write', 'agent.conversation', 'process.spawn', 'workspace.read', 'workspace.write', 'gate.execute', 'artifact.read'] });
  await harness.projectRegistry.register(descriptor, { expectedRevision: 0, commandId: 'scoped-headless-register', authorityDecision: { actor: 'test-user', decision: 'approved', action: 'project-execution-policy-change', expiresAt: '2099-09-15T00:00:00.000Z', context: projectExecutionPolicyDecisionContext({ input: descriptor, expectedRevision: 0 }) } });
  const quality = await harness.createLifecyclePlan({ projectId: descriptor.id, action: 'quality', target: 'V3.8.4', arguments: ['full'], extensionId: extension.id, executionWorkspaceRoot: workspaceRoot });
  const deniedPreflight = await harness.createExecutionReadinessReport(quality);
  assert.equal(deniedPreflight.executionReady, false);
  assert.equal(deniedPreflight.checks.find(check => check.id === 'command-grant').issues[0].code, 'LIFECYCLE_EXECUTION_GRANT_REQUIRED');
  const authorizedQuality = await harness.createLifecyclePlan({ projectId: descriptor.id, action: 'quality', target: 'V3.8.4', arguments: ['full'], extensionId: extension.id, executionWorkspaceRoot: workspaceRoot, executionAuthorizationEvidence: { explicitUnattended: true } });
  const planning = await harness.createLifecyclePlan({ projectId: descriptor.id, action: 'plan', target: 'V3.8.4', extensionId: extension.id, executionWorkspaceRoot: workspaceRoot });
  assert.equal(authorizedQuality.run.runtimePluginId, 'codex-cli-runtime');
  assert.equal(authorizedQuality.run.agentExecutionMode, 'headless');
  assert.match(authorizedQuality.run.executionGrant.grantDigest, /^[a-f0-9]{64}$/);
  assert.equal(planning.run.runtimePluginId, 'codex-conversation-runtime');
  assert.equal(planning.run.agentExecutionMode, 'conversation-visible');
  const preflight = await harness.createExecutionReadinessReport(authorizedQuality);
  assert.equal(preflight.executionReady, true);
  assert.deepEqual(preflight.checks.find(check => check.id === 'visible-host').details, { required: false });
  const started = await harness.startLifecyclePlan(authorizedQuality, { commandId: 'headless-lineage-start', preflightReport: preflight });
  assert.equal(started.status, 'started');
  assert.equal(started.reused, false);
  const retried = await harness.startLifecyclePlan(authorizedQuality, { commandId: 'headless-lineage-start', preflightReport: preflight });
  assert.equal(retried.reused, true);
  assert.equal(retried.state.runId, started.state.runId);
  const replanned = await harness.createLifecyclePlan({ projectId: descriptor.id, action: 'quality', target: 'V3.8.4', arguments: ['full'], extensionId: extension.id, executionWorkspaceRoot: workspaceRoot, executionAuthorizationEvidence: { explicitUnattended: true } });
  assert.equal(replanned.planDigest, authorizedQuality.planDigest);
  assert.equal(replanned.run.runId, authorizedQuality.run.runId);
  const resumePreflight = await harness.createExecutionReadinessReport(replanned);
  assert.equal(resumePreflight.checks.find(check => check.id === 'run-lineage').details.resolution.action, 'continue');
  const observedChange = await harness.kernel.recordDecision(descriptor.id, started.state.runId, { id: 'non-protected-observation', actor: 'test', decision: 'recorded' }, { expectedRevision: started.state.revision, commandId: 'record-lineage-observation' });
  assert.equal(observedChange.state.revision, started.state.revision + 1);
  const internallyResolved = await harness.startLifecyclePlan(replanned, { commandId: 'headless-lineage-re-resolve', preflightReport: resumePreflight });
  assert.equal(internallyResolved.lineageResolution.action, 'continue');
  const scheduled = await harness.dispatch(descriptor.id, started.state.runId, { maxConcurrency: 1, runtimePluginId: 'codex-cli-runtime' }, { expectedRevision: internallyResolved.state.revision, commandId: 'headless-lineage-schedule' });
  assert.equal(scheduled.result.dispatches.length, 1);
  const recoveryPreflight = await harness.createExecutionReadinessReport(replanned);
  assert.equal(recoveryPreflight.checks.find(check => check.id === 'run-lineage').details.resolution.action, 'ordinary-resume');
  const resumed = await harness.startLifecyclePlan(replanned, { commandId: 'headless-lineage-resume', preflightReport: recoveryPreflight });
  assert.equal(resumed.state.generation, scheduled.state.generation + 1);
  assert.equal(resumed.state.dispatches[0].status, 'superseded');
  await writeFile(resolve(workspaceRoot, 'README.md'), 'changed fixture\n', 'utf8');
  const changedSourcePlan = await harness.createLifecyclePlan({ projectId: descriptor.id, action: 'quality', target: 'V3.8.4', arguments: ['full'], extensionId: extension.id, executionWorkspaceRoot: workspaceRoot, executionAuthorizationEvidence: { explicitUnattended: true } });
  const changedSourcePreflight = await harness.createExecutionReadinessReport(changedSourcePlan);
  await assert.rejects(
    () => harness.startLifecyclePlan(changedSourcePlan, { commandId: 'headless-lineage-start', preflightReport: changedSourcePreflight }),
    error => error.code === 'COMMAND_ID_REUSED',
  );
  const replacement = await harness.startLifecyclePlan(changedSourcePlan, { commandId: 'headless-lineage-replace', preflightReport: changedSourcePreflight });
  assert.equal(replacement.state.runId, changedSourcePlan.run.runId);
  const superseded = await harness.authorityStore.read(descriptor.id, authorizedQuality.run.runId);
  assert.equal(superseded.status, 'superseded');
  await assert.rejects(
    () => harness.dispatch(descriptor.id, superseded.runId, { maxConcurrency: 1, runtimePluginId: 'codex-cli-runtime' }, { expectedRevision: superseded.revision, commandId: 'superseded-lineage-schedule' }),
    error => error.code === 'RUN_LINEAGE_NOT_ACTIVE',
  );
  const changedConstraintHarness = await createHarness({ controlRoot, dataRoot, releaseIdentity, strictProjectIdentity: false, extensions: [extension, runtimeExtension, headlessExtension], executionAuthorizationAdapter: createTestExecutionAuthorizationAdapter({ revision: 2, decisionLineage: 'test-user-explicit-policy-v2' }), allowedPluginPermissions: ['state.write', 'agent.conversation', 'process.spawn', 'workspace.read', 'workspace.write', 'gate.execute', 'artifact.read'] });
  const staleConstraintPreflight = await changedConstraintHarness.createExecutionReadinessReport(authorizedQuality);
  assert.equal(staleConstraintPreflight.executionReady, false);
  assert.equal(staleConstraintPreflight.checks.find(check => check.id === 'command-grant').issues[0].code, 'EXECUTION_CONSTRAINT_STALE');
  assert.equal((await harness.authorityStore.read(descriptor.id, authorizedQuality.run.runId)).runId, authorizedQuality.run.runId);
});

test('lifecycle planning automatically resolves an inactive incompatible logical Run', async t => {
  const controlRoot = resolve(process.cwd());
  const tempParent = resolve(harnessTemporaryRoot(), 'lifecycle-command-tests');
  await mkdir(tempParent, { recursive: true });
  const root = await mkdtemp(resolve(tempParent, 'conflict-'));
  const workspaceRoot = resolve(root, 'CardWorld');
  const dataRoot = resolve(root, 'data');
  await mkdir(resolve(workspaceRoot, '.git'), { recursive: true });
  await writeFile(resolve(workspaceRoot, 'README.md'), 'fixture\n', 'utf8');
  t.after(() => rm(root, { recursive: true, force: true }));
  const extension = await loadExtensionPack('./src/consumers/cardworld-engine.mjs', { cwd: controlRoot, controlRoot });
  const runtimeExtension = await loadExtensionPack('./src/extensions/codex-runtime.mjs', { cwd: controlRoot, controlRoot });
  const headlessExtension = await loadExtensionPack('./src/extensions/codex-headless-runtime.mjs', { cwd: controlRoot, controlRoot });
  const harness = await createHarness({ controlRoot, dataRoot, releaseIdentity, strictProjectIdentity: false, extensions: [extension, runtimeExtension, headlessExtension], executionAuthorizationAdapter: createTestExecutionAuthorizationAdapter(), allowedPluginPermissions: ['state.write', 'agent.conversation', 'process.spawn', 'workspace.read', 'workspace.write', 'gate.execute', 'artifact.read'] });
  const descriptor = createCardWorldProjectDescriptor({ workspaceRoot, harness: releaseIdentity, runtimePluginIds: ['codex-conversation-runtime', 'codex-cli-runtime'], actionExecution: { quality: { agentExecutionMode: 'headless', runtimePluginId: 'codex-cli-runtime' } } });
  descriptor.gateRecipes = [];
  descriptor.extensions = descriptor.extensions.map(item => ({ ...item, digest: item.id === extension.id ? extension.digest : item.id === runtimeExtension.id ? runtimeExtension.digest : headlessExtension.digest }));
  await harness.projectRegistry.register(descriptor, { expectedRevision: 0, commandId: 'conflict-project-register', authorityDecision: { actor: 'test-user', decision: 'approved', action: 'project-execution-policy-change', expiresAt: '2099-09-15T00:00:00.000Z', context: projectExecutionPolicyDecisionContext({ input: descriptor, expectedRevision: 0 }) } });
  await harness.startRun({
    projectId: descriptor.id,
    runId: 'historical-quality-run',
    profileId: 'engine-delivery',
    profileConfig: { requireCanonicalDecision: false, requireUserCodeReview: false, requireFinalQualityReview: true },
    features: [{ id: 'quality/old', acceptance: ['review'], dependsOn: [], allowedPaths: [], metadata: { stage: 'quality', qualityReview: true, qualityRoot: 'engine:V3.8.4', sourcePolicy: 'review-and-repair' } }],
    metadata: { commandIntent: { action: 'quality', target: 'V3.8.4' } },
    executionAuthorizationEvidence: { explicitUnattended: true },
  }, { commandId: 'start-historical-quality' });
  const plan = await harness.createLifecyclePlan({ projectId: descriptor.id, action: 'quality', target: 'V3.8.4', arguments: ['full'], extensionId: extension.id, executionWorkspaceRoot: workspaceRoot, executionAuthorizationEvidence: { explicitUnattended: true } });
  const preflight = await harness.createExecutionReadinessReport(plan);
  assert.equal(preflight.executionReady, true);
  const lineage = preflight.checks.find(check => check.id === 'run-lineage');
  assert.equal(lineage.ready, true);
  assert.equal(lineage.details.resolution.action, 'supersede-and-start');
  assert.equal(lineage.details.resolution.reasonCode, 'INCOMPATIBLE_RUNS_SAFE_TO_SUPERSEDE');
  assert.equal(lineage.issues.length, 0);
  const started = await harness.startLifecyclePlan(plan, { commandId: 'automatic-lineage-resolution', preflightReport: preflight });
  assert.equal(started.state.runId, plan.run.runId);
  assert.equal((await harness.authorityStore.read(descriptor.id, 'historical-quality-run')).status, 'superseded');
  assert.equal((await harness.lineageStore.read(descriptor.id, plan.logicalTaskKey)).activeRunId, plan.run.runId);
});

test('release activation stages a complete generation and switches the active pointer once', async t => {
  const controlRoot = resolve(process.cwd());
  const tempParent = resolve(harnessTemporaryRoot(), 'lifecycle-command-tests');
  await mkdir(tempParent, { recursive: true });
  const root = await mkdtemp(resolve(tempParent, 'activation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = resolve(root, 'CardWorld');
  const dataRoot = resolve(root, 'data');
  await mkdir(resolve(workspaceRoot, '.git'), { recursive: true });
  await writeFile(resolve(workspaceRoot, 'README.md'), 'fixture\n', 'utf8');
  const release = await loadReleaseIdentity({ root: controlRoot });
  const extensionRegistry = new ExtensionRegistry({ controlRoot, dataRoot });
  const extension = await extensionRegistry.register('./src/consumers/cardworld-engine.mjs', { cwd: controlRoot, expectedRevision: 0, commandId: 'activation-extension', authorityDecision: { actor: 'test', decision: 'approved' } });
  const runtime = await extensionRegistry.register('./src/extensions/codex-runtime.mjs', { cwd: controlRoot, expectedRevision: 1, commandId: 'activation-runtime', authorityDecision: { actor: 'test', decision: 'approved' } });
  const projects = new ProjectRegistry({ root: dataRoot, controlRoot });
  const descriptor = createCardWorldProjectDescriptor({ workspaceRoot, harness: { version: release.version, artifactDigest: release.artifactDigest } });
  descriptor.extensions = descriptor.extensions.map(item => ({ ...item, digest: item.id === extension.id ? extension.digest : runtime.digest }));
  await projects.register(descriptor, { expectedRevision: 0, commandId: 'activation-project' });
  const nextDescriptor = structuredClone(descriptor);
  nextDescriptor.policy.visibleHeartbeatTimeoutMs = 60000;
  const descriptorWithGrant = structuredClone(nextDescriptor);
  descriptorWithGrant.policy.executionGrant = { actor: 'user', decision: 'approved' };
  await assert.rejects(
    () => createReleaseActivationPlan({ controlRoot, dataRoot, releaseIdentity: release, projectDescriptors: [descriptorWithGrant] }),
    error => error.code === 'DESCRIPTOR_EXECUTION_AUTHORIZATION_FORBIDDEN',
  );
  const descriptorWithLegacyApproval = structuredClone(nextDescriptor);
  descriptorWithLegacyApproval.policy.actionExecution = { quality: { agentExecutionMode: 'headless', runtimePluginId: 'codex-conversation-runtime', authorization: { actor: 'user', decision: 'approved' } } };
  await assert.rejects(
    () => createReleaseActivationPlan({ controlRoot, dataRoot, releaseIdentity: release, projectDescriptors: [descriptorWithLegacyApproval] }),
    error => error.code === 'LEGACY_DESCRIPTOR_AUTHORIZATION_FORBIDDEN',
  );
  const plan = await createReleaseActivationPlan({ controlRoot, dataRoot, releaseIdentity: release, projectDescriptors: [nextDescriptor], now: () => '2026-09-14T13:00:00.000Z' });
  const alternativeDescriptor = structuredClone(nextDescriptor);
  alternativeDescriptor.policy.visibleHeartbeatTimeoutMs = 90000;
  const alternativePlan = await createReleaseActivationPlan({ controlRoot, dataRoot, releaseIdentity: release, projectDescriptors: [alternativeDescriptor], now: () => '2026-09-14T13:00:00.000Z' });
  assert.notEqual(plan.generationId, alternativePlan.generationId);
  assert.equal(plan.projects[0].nextDescriptor.policy.visibleHeartbeatTimeoutMs, 60000);
  const decision = { actor: 'test', decision: 'approved', action: 'release-activation', context: { planDigest: plan.planDigest } };
  const applied = await applyReleaseActivationPlan(plan, { controlRoot, dataRoot, releaseIdentity: release, commandId: 'activation-apply', authorityDecision: decision, now: () => '2026-09-14T13:00:01.000Z' });
  assert.equal(applied.reused, false);
  const pointer = JSON.parse(await readFile(activeReleaseFile(dataRoot), 'utf8'));
  assert.equal(pointer.generationId, plan.generationId);
  assert.equal(pointer.runtimeRoot, plan.runtime.relativeRoot);
  await access(applied.runtimeEntrypoint);
  const activeExtension = await extensionRegistry.loadOneArtifact(extension.id);
  assert.equal(activeExtension.artifact.resolvedPath.startsWith(applied.runtimeRoot), true);
  const activeProject = await projects.get(descriptor.id);
  assert.equal(activeProject.revision, 2);
  assert.equal(activeProject.policy.visibleHeartbeatTimeoutMs, 60000);
  const repeated = await applyReleaseActivationPlan(plan, { controlRoot, dataRoot, releaseIdentity: release, commandId: 'activation-apply', authorityDecision: decision, now: () => '2026-09-14T13:00:02.000Z' });
  assert.equal(repeated.reused, true);
});
