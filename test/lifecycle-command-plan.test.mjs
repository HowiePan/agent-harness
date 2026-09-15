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
  assert.deepEqual(first.protectedOperations.includes('hard-recovery'), true);
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

test('lifecycle planning reports every conflicting active logical Run before start', async t => {
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
  const harness = await createHarness({ controlRoot, dataRoot, releaseIdentity, strictProjectIdentity: false, extensions: [extension, runtimeExtension] });
  const descriptor = createCardWorldProjectDescriptor({ workspaceRoot, harness: releaseIdentity });
  descriptor.gateRecipes = [];
  descriptor.extensions = descriptor.extensions.map(item => ({ ...item, digest: item.id === extension.id ? extension.digest : runtimeExtension.digest }));
  await harness.projectRegistry.register(descriptor, { expectedRevision: 0, commandId: 'conflict-project-register' });
  await harness.startRun({
    projectId: descriptor.id,
    runId: 'historical-quality-run',
    profileId: 'engine-delivery',
    profileConfig: { requireCanonicalDecision: false, requireUserCodeReview: false, requireFinalQualityReview: true },
    features: [{ id: 'quality/old', acceptance: ['review'], dependsOn: [], allowedPaths: [], metadata: { stage: 'quality', qualityReview: true, qualityRoot: 'engine:V3.8.4', sourcePolicy: 'review-and-repair' } }],
    metadata: { commandIntent: { action: 'quality', target: 'V3.8.4' } },
  }, { commandId: 'start-historical-quality' });
  const plan = await harness.createLifecyclePlan({ projectId: descriptor.id, action: 'quality', target: 'V3.8.4', arguments: ['full'], extensionId: extension.id, executionWorkspaceRoot: workspaceRoot });
  assert.deepEqual(plan.authority.activeRunConflicts, [{ runId: 'historical-quality-run', revision: 1, status: 'ready' }]);
  const preflight = await harness.createExecutionReadinessReport(plan);
  assert.equal(preflight.executionReady, false);
  assert.equal(preflight.checks.find(check => check.id === 'run-lineage').issues[0].code, 'ACTIVE_LOGICAL_RUN_CONFLICT');
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
  const plan = await createReleaseActivationPlan({ controlRoot, dataRoot, releaseIdentity: release, now: () => '2026-09-14T13:00:00.000Z' });
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
  const repeated = await applyReleaseActivationPlan(plan, { controlRoot, dataRoot, releaseIdentity: release, commandId: 'activation-apply', authorityDecision: decision, now: () => '2026-09-14T13:00:02.000Z' });
  assert.equal(repeated.reused, true);
});
