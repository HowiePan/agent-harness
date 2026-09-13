import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildDispatchPacket } from '../src/kernel/kernel.mjs';
import { command, dispatchAndBind, feature, makeFixture, recordResult, startRun } from './test-support.mjs';

test('engine profile keeps canonical requirement single-line before implementation fan-out', async t => {
  const fixture = await makeFixture({ profiles: ['engine-delivery'] }); t.after(() => fixture.cleanup());
  await startRun(fixture, { profileId: 'engine-delivery', features: [
    feature('intake', { stage: 'requirement-intake' }),
    feature('canonical', { stage: 'canonical-requirement' }, { dependsOn: ['intake'] }),
    feature('implementation-a', { stage: 'implementation' }, { dependsOn: ['canonical'] }),
    feature('implementation-b', { stage: 'implementation' }, { dependsOn: ['canonical'] }),
  ] });
  let bound = await dispatchAndBind(fixture, 'run');
  assert.equal(bound.dispatch.featureId, 'intake');
  await recordResult(fixture, 'run', bound.dispatch);
  bound = await dispatchAndBind(fixture, 'run');
  assert.equal(bound.dispatch.featureId, 'canonical');
  await recordResult(fixture, 'run', bound.dispatch);
  let state = await fixture.harness.authorityStore.read(fixture.projectId, 'run');
  const blocked = await fixture.harness.dispatch(fixture.projectId, 'run', { maxConcurrency: 2 }, command(state));
  assert.equal(blocked.result.dispatches.length, 0);
  state = blocked.state;
  const decided = await fixture.harness.kernel.recordDecision(fixture.projectId, 'run', { id: 'canonical-requirement-approved', actor: 'user', decision: 'approved' }, command(state));
  const scheduled = await fixture.harness.dispatch(fixture.projectId, 'run', { maxConcurrency: 2 }, command(decided.state));
  assert.deepEqual(scheduled.result.dispatches.map(item => item.featureId).sort(), ['implementation-a', 'implementation-b']);
});

test('managed output path and generation reject stale or overridden submissions', async t => {
  const fixture = await makeFixture(); t.after(() => fixture.cleanup());
  await startRun(fixture);
  const bound = await dispatchAndBind(fixture, 'run');
  const state = bound.state;
  await assert.rejects(() => fixture.harness.kernel.submit(fixture.projectId, 'run', { dispatchId: bound.dispatch.dispatchId, outputRef: 'caller-output.json', agentId: bound.lease.agentId, packetDigest: bound.dispatch.packetDigest, epoch: 1, generation: 1, result: { status: 'completed', summary: 'bad' }, evidenceRefs: [] }, command(state)), error => error.code === 'OUTPUT_REF_OVERRIDE_REJECTED');
  const recovered = await fixture.harness.kernel.recover(fixture.projectId, 'run', { mode: 'ordinary-resume' }, command(state));
  await assert.rejects(() => fixture.harness.kernel.submit(fixture.projectId, 'run', { dispatchId: bound.dispatch.dispatchId, outputRef: bound.dispatch.outputRef, agentId: bound.lease.agentId, packetDigest: bound.dispatch.packetDigest, epoch: 1, generation: 1, result: { status: 'blocked', summary: 'late' }, evidenceRefs: [] }, command(recovered.state)), error => error.code === 'ACTIVE_LEASE_REQUIRED');
});

test('submission rejects changed files outside Feature authorization', async t => {
  const fixture = await makeFixture(); t.after(() => fixture.cleanup());
  await startRun(fixture);
  const bound = await dispatchAndBind(fixture, 'run');
  const state = bound.state;
  const evidence = await fixture.harness.evidenceStore.put({ result: 'bad path' }, { projectId: fixture.projectId, runId: 'run', epoch: 1, generation: 1, featureId: 'one', dispatchId: bound.dispatch.dispatchId, sourceDigest: bound.dispatch.sourceDigest, policyDigest: state.policyDigest, pluginSetDigest: state.pluginSetDigest });
  await assert.rejects(() => fixture.harness.kernel.submit(fixture.projectId, 'run', { dispatchId: bound.dispatch.dispatchId, outputRef: bound.dispatch.outputRef, agentId: bound.lease.agentId, packetDigest: bound.dispatch.packetDigest, epoch: 1, generation: 1, resultingSourceDigest: state.sourceDigest, result: { status: 'completed', summary: 'bad', changedFiles: ['outside/file.mjs'] }, evidenceRefs: [evidence.ref] }, command(state)), error => error.code === 'FEATURE_PATH_NOT_ALLOWED');
});

test('Application derives changed files from snapshots and rejects an omitted unauthorized edit', async t => {
  const fixture = await makeFixture(); t.after(() => fixture.cleanup());
  await startRun(fixture);
  const bound = await dispatchAndBind(fixture, 'run');
  await mkdir(resolve(fixture.workspace, 'outside'));
  await writeFile(resolve(fixture.workspace, 'outside', 'unclaimed.txt'), 'unauthorized', 'utf8');
  await assert.rejects(() => fixture.harness.recordResult(fixture.projectId, 'run', bound.dispatch.dispatchId, { status: 'completed', summary: 'omitted changed files' }, { commandId: command().commandId }), error => error.code === 'FEATURE_PATH_NOT_ALLOWED');
});

test('review findings returned by a Runtime are atomically opened with submission evidence', async t => {
  const fixture = await makeFixture({ profiles: ['engine-delivery'] }); t.after(() => fixture.cleanup());
  await startRun(fixture, {
    profileId: 'engine-delivery',
    profileConfig: { requireCanonicalDecision: false, requireUserCodeReview: false },
    features: [feature('quality/full-sweep', { stage: 'quality' }, { ownerRole: 'reviewer', allowedPaths: [] })],
  });
  const bound = await dispatchAndBind(fixture, 'run');
  const output = await recordResult(fixture, 'run', bound.dispatch, { status: 'completed', summary: 'review completed', changedFiles: [], findings: [{ id: 'Q-001', severity: 'P2', summary: 'current defect', evidence: ['src/example.rs:10'] }] });
  assert.equal(output.state.findings.length, 1);
  assert.equal(output.state.findings[0].featureId, 'quality/full-sweep');
  assert.deepEqual(output.state.findings[0].evidence, ['src/example.rs:10']);
  assert.deepEqual(output.state.findings[0].evidenceRefs, output.result.submission.evidenceRefs);
  assert.equal(output.state.status, 'closure-blocked');
});

test('Dispatch packet keeps the Gate snapshot captured at scheduling time', () => {
  const state = { projectId: 'project', runId: 'run', profile: { id: 'engine-delivery' }, epoch: 1, generation: 1, sourceDigest: 'a'.repeat(64), policyDigest: 'b'.repeat(64), pluginSetDigest: 'c'.repeat(64), artifactDigest: null, gates: [{ id: 'new', status: 'failed' }] };
  const dispatch = { dispatchId: 'dispatch-1', outputRef: 'output.json', sourceDigest: state.sourceDigest, sourceSnapshotRef: 'evidence:snapshot', gateSnapshot: [{ id: 'captured', status: 'passed' }] };
  const packet = buildDispatchPacket(state, dispatch, feature('quality/full-sweep', { stage: 'quality' }));
  assert.deepEqual(packet.gates, [{ id: 'captured', status: 'passed' }]);
});
