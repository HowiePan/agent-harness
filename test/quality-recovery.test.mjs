import assert from 'node:assert/strict';
import test from 'node:test';
import { command, dispatchAndBind, makeFixture, recordResult, startRun } from './test-support.mjs';

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
  const fixture = await makeFixture(); t.after(() => fixture.cleanup());
  await startRun(fixture);
  const bound = await dispatchAndBind(fixture, 'run');
  const failed = await recordResult(fixture, 'run', bound.dispatch, { status: 'failed', summary: 'failed once', failureClass: 'product' });
  const key = Object.keys(failed.state.attempts)[0];
  await assert.rejects(() => fixture.harness.kernel.recover(fixture.projectId, 'run', { mode: 'hard-recovery', assessmentDigest: 'assessment', dispositions: { one: 'verified-current' } }, command(failed.state)), error => error.code === 'RECOVERY_VERIFIED_EVIDENCE_REQUIRED');
  const recovered = await fixture.harness.kernel.recover(fixture.projectId, 'run', { mode: 'hard-recovery', assessmentDigest: 'assessment', dispositions: { one: 'stale-revalidate' } }, command(failed.state));
  assert.equal(recovered.state.epoch, 2);
  assert.equal(recovered.state.features[0].state, 'pending');
  assert.equal(recovered.state.attempts[key].failures, 1);
});

test('coordinated hard recovery archives a rollback snapshot and rollback starts another safe epoch', async t => {
  const fixture = await makeFixture(); t.after(() => fixture.cleanup());
  const original = await startRun(fixture);
  const recovered = await fixture.harness.recovery.hardRecover({
    projectId: fixture.projectId,
    runId: 'run',
    assessment: { assessmentDigest: 'assessment-digest', sourceDigest: original.sourceDigest },
    dispositions: { one: 'stale-revalidate' },
  }, command(original));
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
  const boundSecond = await fixture.harness.kernel.bindLease(fixture.projectId, 'run', { dispatchId: pendingDispatch.dispatchId, agentId: 'agent-unaffected', packetDigest: pendingDispatch.packetDigest, runtimeReceipt: { runtimePluginId: 'test-runtime' } }, command(state));
  result = await fixture.harness.recordResult(fixture.projectId, 'run', pendingDispatch.dispatchId, { status: 'completed', summary: 'done' }, { commandId: command().commandId });
  const rebased = await fixture.harness.kernel.rebaseArtifact(fixture.projectId, 'run', { artifactDigest: 'artifact-b', impactedFeatureIds: ['affected'] }, command(result.state));
  assert.equal(rebased.state.features.find(item => item.id === 'affected').state, 'pending');
  assert.equal(rebased.state.features.find(item => item.id === 'unaffected').state, 'completed');
  assert.equal(rebased.state.generation, 2);
});
