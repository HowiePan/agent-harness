import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createLifecycleCommandBoundary, createLifecycleCommandHost } from '../src/application/lifecycle-command-context.mjs';
import { createHarness } from '../src/application/harness.mjs';
import { harnessTemporaryRoot } from '../src/common/write-boundary.mjs';
import { makeFixture, feature } from './test-support.mjs';

const setup = async t => {
  const parent = harnessTemporaryRoot(); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'command-boundary-')); t.after(() => rm(root, { recursive: true, force: true }));
  let active = true, purpose = 'business';
  const scope = { projectId: 'isolated', action: 'implement', target: 'V-next', workspaceRoot: resolve(root, 'workspace') };
  const host = createLifecycleCommandHost({ provider: 'isolated-native-user',
    verifyCommand: async request => ({ verified: true, purpose, reference: 'one-native-user-event', commandId: request.commandId, scope }),
    verifyActive: async () => ({ active }) });
  const boundary = createLifecycleCommandBoundary({ root, host });
  const plan = { project: { id: scope.projectId }, intent: { action: scope.action, target: scope.target },
    harness: {}, run: { runId: 'first', executionWorkspaceRoot: scope.workspaceRoot, features: [] }, planDigest: 'sealed-plan' };
  return { root, scope, host, boundary, plan, revoke: () => { active = false; }, maintenance: () => { purpose = 'maintenance'; } };
};

test('old metadata, JSON flags and maintenance do not establish a current command or cause effects', async t => {
  const f = await setup(t); let effects = 0;
  for (const candidate of [null, {}, { verified: true }, { commandId: 'old', authorization: 'approved' }]) {
    await assert.rejects(f.boundary.assertPlan({ ...f.plan, currentCommand: candidate }), { code: 'CURRENT_USER_COMMAND_REQUIRED' });
  }
  f.maintenance();
  await assert.rejects(f.boundary.run({ commandId: 'maintenance' }, async () => { effects++; }), { code: 'CURRENT_USER_COMMAND_REQUIRED' });
  assert.equal(effects, 0); assert.deepEqual(await readdir(f.root), []);
});

test('same live command retains contract and finite recovery across replacement Runs and error labels', async t => {
  const f = await setup(t);
  await f.boundary.run({ commandId: 'user-command' }, async () => {
    await f.boundary.assertPlan(f.plan, 'user-command');
    for (const runId of ['second', 'third']) {
      const plan = { ...f.plan, run: { ...f.plan.run, runId } };
      const reservation = await f.boundary.reserveContinuation(plan, { metadata: { lifecycleInvocationId: 'user-command' } });
      assert.equal(reservation.commandId, 'user-command');
    }
    await assert.rejects(f.boundary.reserveContinuation({ ...f.plan, run: { ...f.plan.run, runId: 'fourth' } },
      { metadata: { lifecycleInvocationId: 'user-command', failureClass: 'different-error-name' } }), { code: 'COMMAND_RECOVERY_EXHAUSTED' });
    await assert.rejects(f.boundary.assertPlan(f.plan), { code: 'CURRENT_USER_COMMAND_REQUIRED' });
  });
  const [file] = await readdir(resolve(f.root, 'lifecycle-commands'));
  const record = JSON.parse(await readFile(resolve(f.root, 'lifecycle-commands', file), 'utf8'));
  assert.equal(record.recoveries, 2); assert.equal(record.status, 'exhausted');
  const restarted = createLifecycleCommandBoundary({ root: f.root, host: f.host });
  await assert.rejects(restarted.run({ commandId: 'new-id-same-event' }, async () => {}), { code: 'USER_COMMAND_ALREADY_CONSUMED' });
});

test('closed context, detached callbacks, user stops and nested lifecycle initiation cannot revive execution', async t => {
  const f = await setup(t); let detached;
  await f.boundary.run({ commandId: 'user-command' }, async () => {
    await f.boundary.assertPlan(f.plan);
    await assert.rejects(f.boundary.run({ commandId: 'internal-new-command' }, async () => {}), { code: 'LIFECYCLE_COMMAND_NESTING_DENIED' });
    detached = () => f.boundary.assertPlan(f.plan);
    f.revoke();
    await assert.rejects(f.boundary.assertPlan(f.plan), { code: 'CURRENT_USER_COMMAND_INACTIVE' });
  });
  await assert.rejects(detached(), { code: 'CURRENT_USER_COMMAND_REQUIRED' });
});

test('project, target, workspace, permissions and contract stay bound during a live user command', async t => {
  const f = await setup(t);
  await f.boundary.run({ commandId: 'user-command' }, async () => {
    await f.boundary.assertPlan(f.plan);
    for (const mutate of [p => p.project.id = 'neighbor', p => p.intent.target = 'other', p => p.run.executionWorkspaceRoot += '-other',
      p => p.run.runtimePluginId = 'hidden-runtime', p => p.run.features = [{ id: 'expanded' }], p => p.protectedOperations = ['publish']]) {
      const plan = structuredClone(f.plan); mutate(plan);
      await assert.rejects(f.boundary.assertPlan(plan), error => ['CURRENT_USER_COMMAND_SCOPE_MISMATCH', 'CURRENT_USER_COMMAND_CONTRACT_CHANGED'].includes(error.code));
    }
    await assert.rejects(f.boundary.assertPlan({...f.plan,run:{...f.plan.run,runId:'unsealed-replacement'}}),{code:'CURRENT_USER_COMMAND_RUN_CHANGED'});
    await assert.rejects(f.boundary.assertState({projectId:f.scope.projectId,runId:'foreign-run',status:'ready',
      metadata:{commandIntent:f.plan.intent,workspace:{root:f.scope.workspaceRoot},lifecyclePlanDigest:f.plan.planDigest}}),{code:'CURRENT_USER_COMMAND_RUN_CHANGED'});
    await assert.rejects(f.boundary.reserveContinuation(f.plan, { metadata: { lifecycleInvocationId: 'historical-command' } }), { code: 'CURRENT_USER_COMMAND_LINEAGE_MISMATCH' });
    await assert.rejects(f.boundary.assertStart({ projectId: f.scope.projectId, runId: 'forged', features: [feature('outside')],
      metadata: { commandIntent: f.plan.intent, lifecyclePlanDigest: f.plan.planDigest }, executionWorkspaceRoot: f.scope.workspaceRoot }, {}), { code: 'CURRENT_USER_COMMAND_CONTRACT_CHANGED' });
  });
});

test('public startup, preflight and equivalent raw Run APIs deny execution before creating a Run', async t => {
  const f = await makeFixture(); t.after(f.cleanup);
  const core = await createHarness({ dataRoot: f.dataRoot, initializeStorage: false, strictProjectIdentity: false,
    releaseIdentity: { version: '1.0.0', artifactDigest: null } });
  const plan = { project: { id: f.projectId }, intent: { action: 'implement', target: 'V-next' }, run: { executionWorkspaceRoot: f.workspace } };
  for (const operation of [() => core.executeVisibleLifecyclePlan(plan, { commandId: 'old-command' }),
    () => core.executeLifecyclePlan(plan, { commandId: 'old-command' }), () => core.createExecutionReadinessReport(plan),
    () => core.continueVisibleLifecyclePlan(plan, { priorRunId: 'historical' }),
    () => core.startRun({ projectId: f.projectId, runId: 'raw-bypass', features: [feature('one')] }, { commandId: 'raw' }),
    () => core.promoteVersionRelease({projectId:f.projectId,target:'V-next',approval:{actor:'claimed-user',decision:'approved'}}),
    () => core.promoteScopedRelease({projectId:f.projectId,target:'V-next'}),
    () => core.publishVersionRelease({projectId:f.projectId,target:'V-next'}),
    () => core.withUserLifecycleCommand({ commandId: 'claimed', verified: true }, async () => {})]) {
    await assert.rejects(operation(), { code: 'CURRENT_USER_COMMAND_REQUIRED' });
  }
  assert.deepEqual(await core.authorityStore.list(f.projectId), []);
});

test('reentering one lifecycle uses the same bounded recovery and cannot reset it by selecting a new command suffix', async t => {
  const f = await setup(t); let executed = 0;
  await f.boundary.run({ commandId: 'user-command' }, async () => {
    for (let attempt = 0; attempt < 3; attempt++) await f.boundary.execute(f.plan, `user-command.retry-${attempt}`, async () => { executed++; });
    await assert.rejects(f.boundary.execute(f.plan, 'user-command.new-suffix', async () => { executed++; }), { code: 'COMMAND_RECOVERY_EXHAUSTED' });
  });
  assert.equal(executed, 3);
});
