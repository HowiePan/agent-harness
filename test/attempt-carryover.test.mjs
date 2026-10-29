import assert from 'node:assert/strict';
import test from 'node:test';
import { makeFixture, startRun, feature, dispatchAndBind, recordResult, command } from './test-support.mjs';
import { prepareBudgetExtension } from '../src/kernel/attempt-budget.mjs';
import { sealLifecycleExecutionGrant } from '../src/platform/execution/authorization.mjs';

const blocked = { status: 'blocked', summary: 'Verified work remains.', changedFiles: [], failureClass: 'implementation-incomplete',
  blocker: { kind: 'implementation', summary: 'Implement remaining behavior.' } };
const fixture = async t => {
  const f = await makeFixture(); t.after(f.cleanup);
  const anchor = feature('owner', {}, { logicalRoot: 'stable-owner', attemptLimit: 1 });
  await startRun(f, { features: [anchor] });
  const first = await dispatchAndBind(f, 'run');
  const prior = (await recordResult(f, 'run', first.dispatch, blocked)).state;
  const child = feature('receiver', {}, { logicalRoot: anchor.logicalRoot, attemptLimit: 1 });
  const input = { projectId: f.projectId, runId: 'next', profileId: prior.profile.id, profileConfig: prior.profile.config,
    sourceDigest: prior.sourceDigest, policyDigest: prior.policyDigest, pluginSetDigest: prior.pluginSetDigest, artifactDigest: prior.artifactDigest,
    metadata: structuredClone(prior.metadata), features: [{ ...anchor, dependsOn: [child.id] }, child],
    attemptCarryover: { logicalRoots: [anchor.logicalRoot], sources: [{ runId: prior.runId, authorityDigest: prior.authorityDigest }] } };
  const grant = input.metadata.lifecycleExecution.executionGrant;
  grant.grantId = 'test-next'; grant.context.runId = input.runId;
  input.metadata.lifecycleExecution.executionGrant = sealLifecycleExecutionGrant(grant);
  return { ...f, prior, input, anchor, child };
};

test('changed graph carries real exhausted counters and original immutable history; a child cannot bypass its shared budget', async t => {
  const f = await fixture(t);
  let state = (await f.harness.kernel.startRun(f.input, command())).state;
  assert.deepEqual(state.attempts, f.prior.attempts);
  assert.deepEqual(state.submissions, f.prior.submissions);
  assert.equal(state.features[0].state, 'failed-budget');
  assert.equal((await dispatchAndBind(f, 'next')).dispatch, null);
  state = await f.harness.authorityStore.read(f.projectId, 'next');
  const key = Object.keys(state.attempts)[0];
  const proposal = prepareBudgetExtension({ state, featureId: f.anchor.id, attemptKey: key, additional: 2,
    reason: 'Explicit bounded continuation after amended decomposition.', remainingWork: ['Receiver and final owner.'] });
  const approval = { id: 'human-addition', actor: 'human-user', decision: 'approved', action: 'extend-attempt-budget',
    projectId: f.projectId, runId: state.runId, featureId: f.anchor.id, proposalDigest: proposal.proposalDigest };
  const extension = await f.harness.kernel.extendAttemptBudget(f.projectId, state.runId, { proposal, approval }, command(state));
  assert.equal(extension.state.attempts[key].failures, 1);
  assert.equal(extension.state.attempts[key].limit, 3);
  assert.equal((await dispatchAndBind(f, 'next')).dispatch.featureId, f.child.id);
  const stale = structuredClone(f.input); stale.runId = 'stale-transfer';
  await assert.rejects(f.harness.kernel.startRun(stale, command()), { code: 'ATTEMPT_CARRYOVER_STALE' });
});

test('counter transfer rejects stale pins, missing roots and caller-supplied replacement numbers', async t => {
  const f = await fixture(t);
  const wrong = structuredClone(f.input); wrong.attemptCarryover.sources[0].authorityDigest = 'a'.repeat(64);
  await assert.rejects(f.harness.kernel.startRun(wrong, command()), { code: 'ATTEMPT_CARRYOVER_SOURCE_CHANGED' });
  const missing = structuredClone(f.input); missing.attemptCarryover.logicalRoots = ['other'];
  await assert.rejects(f.harness.kernel.startRun(missing, command()), { code: 'ATTEMPT_CARRYOVER_ROOT_MISMATCH' });
  await assert.rejects(f.harness.startRun(f.input, command()), { code: 'ATTEMPT_CARRYOVER_AUTHORITY_REQUIRED' });
});

test('a maintenance execution freeze preserves progress and prevents any new dispatch without creating a replacement Run', async t => {
  const f = await fixture(t);
  const before = f.prior;
  const frozen = await f.harness.kernel.recordDecision(f.projectId, before.runId, {
    id: 'maintenance-freeze', actor: 'project-local-invocation', decision: 'approved', action: 'freeze-execution',
    context: { projectId: f.projectId, runId: before.runId, priorAuthorityDigest: before.authorityDigest, sourceDigest: before.sourceDigest } }, command(before));
  assert.deepEqual(frozen.state.attempts, before.attempts);
  assert.deepEqual(frozen.state.submissions, before.submissions);
  assert.equal(frozen.state.sourceDigest, before.sourceDigest);
  await assert.rejects(dispatchAndBind(f, before.runId), { code: 'RUN_EXECUTION_FROZEN' });
  assert.equal((await f.harness.authorityStore.list(f.projectId)).length, 1);
});
