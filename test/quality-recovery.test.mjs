import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { extensionPack as legacyCompatibilityExtension } from '../src/extensions/legacy-compat.mjs';
import { command, dispatchAndBind, makeFixture, recordResult, startRun } from './test-support.mjs';

const authorizeRecovery = async (fixture, state, suffix = 'recovery', decisionOverrides = {}) => {
  const legacyRoot = resolve(fixture.root, `legacy-${suffix}`);
  await mkdir(legacyRoot, { recursive: true });
  await writeFile(resolve(legacyRoot, 'state.json'), JSON.stringify({ status: 'incomplete' }));
  const capsule = await fixture.harness.recovery.createCapsule({ importerId: 'cardworld-t1-t2-importer', legacyRoot, capsuleId: `capsule-${suffix}`, commandId: `capsule-command-${suffix}` });
  const verified = await fixture.harness.recovery.verifyCapsule(capsule.root, { projectId: fixture.projectId, runId: 'run' });
  const decisionInput = {
    id: `decision-${suffix}`, actor: 'test-owner', decision: 'approved', action: 'live-hard-recovery',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    context: { projectId: fixture.projectId, runId: 'run', verificationRef: verified.verification.verificationRef, targetEpoch: state.epoch + 1, expectedRevision: state.revision + 1 },
    ...decisionOverrides,
  };
  const decided = await fixture.harness.kernel.recordDecision(fixture.projectId, 'run', decisionInput, command(state));
  return { state: decided.state, verificationRef: verified.verification.verificationRef, decisionId: decisionInput.id, capsule };
};

test('P2 and P3 block closure until evidence-backed resolution', async t => {
  const fixture = await makeFixture(); t.after(() => fixture.cleanup());
  await startRun(fixture);
  const bound = await dispatchAndBind(fixture, 'run');
  const completed = await recordResult(fixture, 'run', bound.dispatch);
  let state = completed.state;
  const finding = await fixture.harness.kernel.recordFinding(fixture.projectId, 'run', { id: 'quality-1', severity: 'P2', summary: 'must fix now' }, command(state));
  state = finding.state;
  await assert.rejects(() => fixture.harness.kernel.closeRun(fixture.projectId, 'run', {}, command(state)), error => error.code === 'QUALITY_FINDINGS_OPEN');
  const evidence = await fixture.harness.evidenceStore.put({ fixed: true }, { projectId: fixture.projectId, runId: 'run', epoch: state.epoch, generation: state.generation, sourceDigest: state.sourceDigest, policyDigest: state.policyDigest, pluginSetDigest: state.pluginSetDigest, labels: ['finding-resolution'] });
  const resolved = await fixture.harness.kernel.resolveFinding(fixture.projectId, 'run', { id: 'quality-1', resolution: 'fixed', evidenceRefs: [evidence.ref] }, command(state));
  const closed = await fixture.harness.kernel.closeRun(fixture.projectId, 'run', {}, command(resolved.state));
  assert.equal(closed.state.status, 'closed');
  assert.equal(closed.result.receipt.findingResults[0].status, 'resolved');
});

test('hard recovery retains attempt budgets and refuses old completion without new-epoch evidence', async t => {
  const fixture = await makeFixture({ extensions: [legacyCompatibilityExtension] }); t.after(() => fixture.cleanup());
  await startRun(fixture);
  const bound = await dispatchAndBind(fixture, 'run');
  const failed = await recordResult(fixture, 'run', bound.dispatch, { status: 'failed', summary: 'failed once', failureClass: 'product' });
  const key = Object.keys(failed.state.attempts)[0];
  await assert.rejects(() => fixture.harness.kernel.recover(fixture.projectId, 'run', { mode: 'hard-recovery' }, command(failed.state)), error => error.code === 'RECOVERY_COORDINATOR_REQUIRED');
  const authorized = await authorizeRecovery(fixture, failed.state, 'attempts');
  await assert.rejects(() => fixture.harness.recovery.hardRecover({ projectId: fixture.projectId, runId: 'run', verificationRef: authorized.verificationRef, decisionId: authorized.decisionId, dispositions: { one: 'verified-current' } }, command(authorized.state)), error => error.code === 'RECOVERY_VERIFIED_EVIDENCE_REQUIRED');
  const recovered = await fixture.harness.recovery.hardRecover({ projectId: fixture.projectId, runId: 'run', verificationRef: authorized.verificationRef, decisionId: authorized.decisionId, dispositions: { one: 'stale-revalidate' } }, command(authorized.state));
  assert.equal(recovered.state.epoch, 2);
  assert.equal(recovered.state.features[0].state, 'pending');
  assert.equal(recovered.state.attempts[key].failures, 1);
});

test('coordinated hard recovery archives a rollback snapshot and rollback starts another safe epoch', async t => {
  const fixture = await makeFixture({ extensions: [legacyCompatibilityExtension] }); t.after(() => fixture.cleanup());
  const original = await startRun(fixture);
  const authorized = await authorizeRecovery(fixture, original, 'rollback');
  const recovered = await fixture.harness.recovery.hardRecover({
    projectId: fixture.projectId,
    runId: 'run',
    verificationRef: authorized.verificationRef,
    decisionId: authorized.decisionId,
    dispositions: { one: 'stale-revalidate' },
  }, command(authorized.state));
  const snapshotRef = recovered.state.recoveryArchives.at(-1).rollbackSnapshotRef;
  assert.ok(snapshotRef);
  assert.equal(recovered.state.epoch, 2);
  const rolledBack = await fixture.harness.recovery.rollback({ projectId: fixture.projectId, runId: 'run', rollbackSnapshotRef: snapshotRef }, command(recovered.state));
  assert.equal(rolledBack.state.epoch, 3);
  assert.equal(rolledBack.state.generation, 3);
  assert.equal(rolledBack.state.features[0].state, 'pending');
  assert.equal(rolledBack.state.features[0].recoveryDisposition, 'rollback-revalidate');
  assert.equal(rolledBack.state.events.at(-1).type, 'run.recovery-rolled-back');
});

test('live hard recovery requires a verified Capsule and recorded approval', async t => {
  const fixture = await makeFixture({ extensions: [legacyCompatibilityExtension] }); t.after(() => fixture.cleanup());
  const state = await startRun(fixture);
  await assert.rejects(() => fixture.harness.recovery.hardRecover({ projectId: fixture.projectId, runId: 'run', decisionId: 'missing' }, { expectedRevision: state.revision, commandId: 'missing-verification' }), error => error.code === 'RECOVERY_VERIFICATION_REQUIRED');
  const legacyRoot = resolve(fixture.root, 'legacy-no-decision');
  await mkdir(legacyRoot, { recursive: true });
  await writeFile(resolve(legacyRoot, 'state.json'), '{}');
  const capsule = await fixture.harness.recovery.createCapsule({ importerId: 'cardworld-t1-t2-importer', legacyRoot, capsuleId: 'no-decision', commandId: 'create-no-decision' });
  const verified = await fixture.harness.recovery.verifyCapsule(capsule.root, { projectId: fixture.projectId, runId: 'run' });
  await assert.rejects(() => fixture.harness.recovery.hardRecover({ projectId: fixture.projectId, runId: 'run', verificationRef: verified.verification.verificationRef }, { expectedRevision: state.revision, commandId: 'missing-decision' }), error => error.code === 'RECOVERY_AUTHORITY_DECISION_REQUIRED');
});

test('live hard recovery rejects denied, expired, and context-mismatched decisions', async t => {
  for (const [suffix, overrides, code] of [
    ['denied', { decision: 'denied' }, 'RECOVERY_AUTHORITY_DECISION_REJECTED'],
    ['expired', { expiresAt: new Date(Date.now() - 60_000).toISOString() }, 'RECOVERY_AUTHORITY_DECISION_EXPIRED'],
    ['wrong-context', { context: { projectId: 'wrong', runId: 'run', verificationRef: 'wrong', targetEpoch: 2, expectedRevision: 2 } }, 'RECOVERY_AUTHORITY_DECISION_CONTEXT_MISMATCH'],
  ]) {
    await t.test(suffix, async t => {
      const fixture = await makeFixture({ extensions: [legacyCompatibilityExtension] }); t.after(() => fixture.cleanup());
      const state = await startRun(fixture);
      const authorized = await authorizeRecovery(fixture, state, suffix, overrides);
      await assert.rejects(() => fixture.harness.recovery.hardRecover({ projectId: fixture.projectId, runId: 'run', verificationRef: authorized.verificationRef, decisionId: authorized.decisionId }, { expectedRevision: authorized.state.revision, commandId: `recover-${suffix}` }), error => error.code === code);
    });
  }
});

test('live hard recovery is idempotent for one stable command ID and rejects changed reuse', async t => {
  const fixture = await makeFixture({ extensions: [legacyCompatibilityExtension] }); t.after(() => fixture.cleanup());
  const state = await startRun(fixture);
  const authorized = await authorizeRecovery(fixture, state, 'idempotent');
  const input = { projectId: fixture.projectId, runId: 'run', verificationRef: authorized.verificationRef, decisionId: authorized.decisionId };
  const recoveryCommand = { expectedRevision: authorized.state.revision, commandId: 'recover-idempotent' };
  const first = await fixture.harness.recovery.hardRecover(input, recoveryCommand);
  const repeated = await fixture.harness.recovery.hardRecover(input, recoveryCommand);
  assert.equal(first.state.authorityDigest, repeated.state.authorityDigest);
  assert.equal(repeated.reused, true);
  await assert.rejects(() => fixture.harness.recovery.hardRecover({ ...input, dispositions: { one: 'verified-current' } }, recoveryCommand), error => error.code === 'COMMAND_ID_REUSED');
});

test('artifact rebase invalidates only the declared impact set', async t => {
  const fixture = await makeFixture(); t.after(() => fixture.cleanup());
  await startRun(fixture, { artifactDigest: 'artifact-a', features: [
    { id: 'affected', acceptance: ['accepted'], dependsOn: [], allowedPaths: ['a'], metadata: {} },
    { id: 'unaffected', acceptance: ['accepted'], dependsOn: [], allowedPaths: ['b'], metadata: {} },
  ] });
  let first = await dispatchAndBind(fixture, 'run', { maxConcurrency: 2, index: 0 });
  let result = await recordResult(fixture, 'run', first.dispatch);
  const pendingDispatch = first.dispatches.find(item => item.dispatchId !== first.dispatch.dispatchId);
  let state = result.state;
  const boundSecond = await fixture.harness.bindDispatch(fixture.projectId, 'run', { dispatchId: pendingDispatch.dispatchId, agentId: 'agent-unaffected', runtimeReceipt: { runtimePluginId: 'test-runtime' } }, command(state));
  result = await fixture.harness.recordResult(fixture.projectId, 'run', pendingDispatch.dispatchId, { status: 'completed', summary: 'done' }, { commandId: command().commandId });
  const decision = {
    id: 'approve-artifact-b',
    actor: 'project-owner',
    decision: 'approved',
    action: 'artifact-rebase',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    context: { projectId: fixture.projectId, runId: 'run', expectedRevision: result.state.revision + 1, previousArtifactDigest: result.state.artifactDigest, artifactDigest: 'artifact-b', impactedFeatureIds: ['affected'] },
  };
  const approved = await fixture.harness.kernel.recordDecision(fixture.projectId, 'run', decision, command(result.state));
  const rebased = await fixture.harness.kernel.rebaseArtifact(fixture.projectId, 'run', { artifactDigest: 'artifact-b', impactedFeatureIds: ['affected'], decisionId: decision.id }, command(approved.state));
  assert.equal(rebased.state.features.find(item => item.id === 'affected').state, 'pending');
  assert.equal(rebased.state.features.find(item => item.id === 'unaffected').state, 'completed');
  assert.equal(rebased.state.generation, 2);
});
