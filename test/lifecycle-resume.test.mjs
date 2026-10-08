import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHarness } from '../src/application/harness.mjs';
import { loadExtensionPack } from '../src/platform/extensions/contract.mjs';
import { createCardWorldProjectDescriptor } from '../integrations/legacy-consumers/cardworld/index.mjs';
import { harnessTemporaryRoot } from '../src/common/write-boundary.mjs';
import { selectBlockedResumeFeature, selectImplementationContinuationRun } from '../src/application/lifecycle-resume.mjs';
import { createDeliveryCommandManifest } from '../src/flows/delivery-lifecycle/commands.mjs';
import { batchProductionCommandManifest } from '../src/flows/batch-production/commands.mjs';

test('lifecycle command manifests expose implement without a separate resume action', () => {
  assert.equal(createDeliveryCommandManifest().actions.resume, undefined);
  assert.equal(batchProductionCommandManifest.actions.resume, undefined);
});

test('implement selects one unfinished Run by command identity despite source progress', () => {
  const intent = { action: 'implement', target: 'V3.8.5', preset: 'default', workflowId: 'engine-delivery', profileId: 'engine-delivery' };
  const state = (runId, overrides = {}) => ({ runId, status: 'ready', sourceDigest: runId,
    metadata: { commandIntent: { ...intent } }, ...overrides });
  const candidate = state('f06-run');
  assert.equal(selectImplementationContinuationRun([
    state('old-closed', { status: 'closed' }),
    state('other-target', { metadata: { commandIntent: { ...intent, target: 'V3.9.0' } } }),
    candidate,
  ], intent)?.runId, 'f06-run');
  assert.equal(selectImplementationContinuationRun([state('retired', { status: 'superseded' })], intent), null);
  assert.throws(() => selectImplementationContinuationRun([candidate, state('second-run')], intent),
    error => error.code === 'LIFECYCLE_IMPLEMENT_RUN_AMBIGUOUS');
});

const releaseIdentity = { version: '1.0.0', artifactDigest: 'a'.repeat(64), verified: true };

test('continuation rebuilds the original immutable plan from Run Authority after source progress', async t => {
  const controlRoot = resolve(process.cwd());
  const parent = resolve(harnessTemporaryRoot(), 'lifecycle-resume-tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'resume-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = resolve(root, 'CardWorld');
  await mkdir(resolve(workspaceRoot, '.git'), { recursive: true });
  await writeFile(resolve(workspaceRoot, 'README.md'), 'original\n');
  const extension = await loadExtensionPack('./integrations/legacy-consumers/cardworld/index.mjs', { cwd: controlRoot, controlRoot });
  const runtime = await loadExtensionPack('./integrations/codex/extensions/codex-runtime.mjs', { cwd: controlRoot, controlRoot });
  const harness = await createHarness({ controlRoot, dataRoot: resolve(root, 'data'), releaseIdentity,
    strictProjectIdentity: false, extensions: [extension, runtime] });
  const descriptor = createCardWorldProjectDescriptor({ workspaceRoot, harness: releaseIdentity });
  descriptor.extensions = descriptor.extensions.map(item => ({ ...item, digest: item.id === extension.id ? extension.digest : runtime.digest }));
  await harness.projectRegistry.register(descriptor, { expectedRevision: 0, commandId: 'resume-register' });
  const plan = await harness.createLifecyclePlan({ projectId: descriptor.id, action: 'quality', target: 'V3.8.4',
    arguments: ['full'], extensionId: extension.id, executionWorkspaceRoot: workspaceRoot });
  const started = await harness.startRun({ projectId: descriptor.id, runId: plan.run.runId, profileId: plan.run.profileId,
    features: plan.run.features, profileConfig: plan.run.profileConfig, artifactDigest: plan.run.artifactDigest,
    sourceDigest: plan.run.sourceDigest, executionWorkspaceRoot: plan.run.executionWorkspaceRoot,
    metadata: { ...(plan.run.metadata ?? {}), logicalTaskKey: plan.logicalTaskKey, lifecyclePlanDigest: plan.planDigest,
      lifecycleInvocationId: 'original-command', commandIntent: plan.intent,
      lifecycleExecution: { runtimePluginId: plan.run.runtimePluginId, agentExecutionMode: plan.run.agentExecutionMode,
        executionConstraintDigest: plan.run.executionConstraintDigest, executionGrant: plan.run.executionGrant,
        authorizationSourceDigest: plan.run.sourceDigest, harnessArtifactDigest: plan.harness.artifactDigest,
        extensionDigest: plan.extension.digest }, stopCondition: plan.stopCondition } }, { commandId: 'resume-start' });
  await writeFile(resolve(workspaceRoot, 'README.md'), 'later source\n');
  const resumed = await harness.createLifecycleResumePlan({ projectId: descriptor.id, runId: started.state.runId, executionWorkspaceRoot: workspaceRoot });
  assert.equal(resumed.plan.planDigest, plan.planDigest);
  assert.equal(resumed.plan.run.runId, started.state.runId);
  assert.equal(resumed.blockedFeatureId, null);
  assert.equal(resumed.authorityDigest, started.state.authorityDigest);
  const changedRuntime = await createHarness({ controlRoot, dataRoot: resolve(root, 'data'),
    releaseIdentity: { ...releaseIdentity, artifactDigest: 'b'.repeat(64) }, strictProjectIdentity: false,
    extensions: [extension, runtime] });
  await assert.rejects(() => changedRuntime.createLifecycleResumePlan({ projectId: descriptor.id,
    runId: started.state.runId, executionWorkspaceRoot: workspaceRoot }),
  error => error.code === 'LIFECYCLE_RESUME_IDENTITY_STALE');
  await assert.rejects(() => harness.createLifecycleResumePlan({ projectId: descriptor.id, runId: started.state.runId,
    executionWorkspaceRoot: root }), error => error.code === 'PROJECT_EXECUTION_WORKSPACE_MISMATCH');
});

test('blocked implementation continuation selects only one safe Feature with budget', () => {
  const features = Array.from({ length: 7 }, (_, index) => ({ id: `F0${index}`, logicalRoot: `implement:F0${index}`,
    state: index === 6 ? 'blocked' : 'completed', metadata: { stage: 'implementation' } }));
  const state = { features, submissions: [{ featureId: 'F06', result: { status: 'blocked', failureClass: 'performance-budget-exceeded',
    blocker: { kind: 'in-scope-fix-blocked', summary: 'Frozen performance gate failed.' } } }],
  attempts: { 'implement:F06:performance-budget-exceeded': { failures: 1, exhausted: false } } };
  assert.equal(selectBlockedResumeFeature(state), 'F06');
  assert.deepEqual(state.features.slice(0, 6).map(feature => feature.state), Array(6).fill('completed'));
  assert.throws(() => selectBlockedResumeFeature({ ...state, attempts: { 'implement:F06:performance-budget-exceeded': { exhausted: true } } }),
    error => error.code === 'LIFECYCLE_RESUME_BUDGET_EXHAUSTED');
  assert.throws(() => selectBlockedResumeFeature({ ...state, submissions: [{ featureId: 'F06', result: { status: 'blocked',
    failureClass: 'permission-denied', blocker: { kind: 'permission-denied' } } }] }),
  error => error.code === 'LIFECYCLE_RESUME_BLOCKER_REQUIRES_REVIEW');
  const provider = { ...state, submissions: [{ featureId: 'F06', result: { status: 'failed', failureClass: 'runtime-provider',
    blocker: { kind: 'runtime-provider', code: 'CODEX_COLLABORATION_AGENT_FAILED' } } }],
  attempts: { 'implement:F06:runtime-provider': { failures: 2, exhausted: false } } };
  assert.equal(selectBlockedResumeFeature(provider), 'F06');
  assert.throws(() => selectBlockedResumeFeature({ ...provider,
    attempts: { 'implement:F06:runtime-provider': { failures: 21, exhausted: true } } }),
  error => error.code === 'LIFECYCLE_RESUME_BUDGET_EXHAUSTED');
});

test('a repeated implement command selects the sealed replacement Plan after migration', async t => {
  const controlRoot = resolve(process.cwd());
  const parent = resolve(harnessTemporaryRoot(), 'lifecycle-resume-tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'carryover-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = resolve(root, 'CardWorld');
  await mkdir(resolve(workspaceRoot, '.git'), { recursive: true });
  await writeFile(resolve(workspaceRoot, 'README.md'), 'source\n');
  const extension = await loadExtensionPack('./integrations/legacy-consumers/cardworld/index.mjs', { cwd: controlRoot, controlRoot });
  const runtime = await loadExtensionPack('./integrations/codex/extensions/codex-runtime.mjs', { cwd: controlRoot, controlRoot });
  const harness = await createHarness({ controlRoot, dataRoot: resolve(root, 'data'), releaseIdentity,
    strictProjectIdentity: false, extensions: [extension, runtime] });
  const descriptor = createCardWorldProjectDescriptor({ workspaceRoot, harness: releaseIdentity });
  descriptor.extensions = descriptor.extensions.map(item => ({ ...item, digest: item.id === extension.id ? extension.digest : runtime.digest }));
  await harness.projectRegistry.register(descriptor, { expectedRevision: 0, commandId: 'carryover-register' });
  const command = { projectId: descriptor.id, action: 'implement', target: 'V3.8.5',
    extensionId: extension.id, executionWorkspaceRoot: workspaceRoot };
  const plan = await harness.createLifecyclePlan(command);
  await harness.authorityStore.create({ projectId: descriptor.id, runId: 'retired-implementation',
    status: 'superseded', sourceDigest: plan.run.sourceDigest, metadata: {
      commandIntent: plan.intent, supersededByRunId: plan.run.runId, supersedePlanDigest: plan.planDigest,
      completionCarryover: { plan: { replacementRunId: plan.run.runId, replacementPlanDigest: plan.planDigest },
        replacementPlan: plan },
    }, features: [], dispatches: [], leases: [], submissions: [], findings: [], gates: [], events: [] },
  { commandId: 'carryover-retired-fixture' });
  const repeated = await harness.createLifecyclePlan(command);
  assert.equal(repeated.planDigest, plan.planDigest);
  assert.equal(repeated.run.runId, plan.run.runId);
  await writeFile(resolve(workspaceRoot, 'README.md'), 'changed source\n');
  await assert.rejects(() => harness.createLifecyclePlan(command), error => error.code === 'CARRYOVER_REPLACEMENT_IDENTITY_STALE');
  await harness.authorityStore.create({ projectId: descriptor.id, runId: plan.run.runId,
    status: 'ready', sourceDigest: plan.run.sourceDigest, metadata: {
      lifecyclePlanDigest: plan.planDigest, logicalTaskKey: plan.logicalTaskKey,
    }, features: [], dispatches: [], leases: [], submissions: [], findings: [], gates: [], events: [] },
  { commandId: 'carryover-replacement-fixture' });
  const progressed = await harness.createLifecyclePlan(command);
  assert.notEqual(progressed.planDigest, plan.planDigest);
  assert.notEqual(progressed.run.runId, plan.run.runId);
});
