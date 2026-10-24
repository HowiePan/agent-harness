import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digestJson } from '../src/common/canonical.mjs';
import { captureWorkspace } from '../src/common/workspace-snapshot.mjs';
import { assessInterruptedWorkspace, recoverInterruptedWorkspace, readInterruptedWorkspaceDraft } from '../src/application/interrupted-workspace-recovery.mjs';
import { assessRecoveredImplementationContinuation } from '../src/application/plan-source-compatibility.mjs';
import { makeFixture } from './test-support.mjs';

const H = 'a'.repeat(64);
const fixture = async () => {
  const f = await makeFixture();
  await mkdir(resolve(f.workspace, 'src'));
  await writeFile(resolve(f.workspace, 'src/runtime.txt'), 'baseline');
  const before = await captureWorkspace(f.workspace);
  const state = { projectId: f.projectId, runId: 'original', status: 'ready', revision: 5,
    epoch: 1, generation: 2, sourceDigest: before.digest, artifactDigest: H, policyDigest: H, pluginSetDigest: H,
    authorityDigest: H, evidenceRefs: [], submissions: [], findings: [],
    metadata: { commandIntent: { action: 'implement', target: 'V1' }, workspace: { root: f.workspace } },
    features: [{ id: 'first', state: 'completed', allowedPaths: ['src'], metadata: { stage: 'implementation' } },
      { id: 'second', state: 'pending', allowedPaths: ['src'], forbiddenPaths: ['src/private'],
        metadata: { stage: 'implementation', verificationOutputPaths: ['artifacts'] } }],
    events: [...Array.from({ length: 5 }, (_, index) => ({ sequence: index + 1, type: 'fixture-history' })),
      { sequence: 6, type: 'run.recovered', mode: 'ordinary-resume', epoch: 1, generation: 2,
      previous: { epoch: 1, generation: 1 } }], dispatches: [], leases: [] };
  const snapshot = await f.harness.evidenceStore.put(before, { projectId: f.projectId, runId: state.runId,
    epoch: 1, generation: 1, sourceDigest: before.digest, artifactDigest: H, policyDigest: H, pluginSetDigest: H,
    labels: ['workspace-snapshot'] });
  const dispatch = { dispatchId: 'dispatch', featureId: 'second', sourceDigest: before.digest,
    sourceSnapshotRef: snapshot.ref, epoch: 1, generation: 1, status: 'superseded', packetDigest: H,
    featureSnapshot: structuredClone(state.features[1]) };
  const spawn = { effectId: 'effect', agentId: 'agent', nativeTaskName: 'agent', dispatchId: 'dispatch',
    packetDigest: H, promptDigest: H, sessionId: 'session', requestDigest: H, contract: { id: 'host' } };
  const lease = { leaseId: 'lease', dispatchId: 'dispatch', agentId: 'agent', status: 'superseded',
    epoch: 1, generation: 1, packetDigest: H, runtimeReceipt: { hostSpawnReceipt: spawn, prompt: { promptDigest: H } } };
  state.dispatches.push(dispatch); state.leases.push(lease);
  const effect = { effectId: 'effect', state: 'contained', effectDigest: H, canonicalAgentName: 'agent',
    nativeTaskName: 'agent', sessionId: 'session', requestDigest: H,
    binding: { projectId: f.projectId, runId: state.runId, dispatchId: 'dispatch', packetDigest: H, promptDigest: H },
    outcome: { reason: 'preflight-reconciliation', disposition: 'interrupted', target: 'agent',
      interruptRequestDigest: H, interruptResultDigest: H, verificationRequestDigest: H } };
  await writeFile(resolve(f.workspace, 'src/runtime.txt'), 'unfinished source');
  const after = await captureWorkspace(f.workspace);
  return { ...f, state, before, after, effect, project: { workspace: { excluded: [] } } };
};

test('interrupted draft is retained with source Evidence, without a completion or reactivated Lease', async () => {
  const f = await fixture();
  try {
    const frozen = structuredClone(f.state);
    let transactionCount = 0;
    const authorityStore = { async transact(projectId, runId, command, update) {
      transactionCount++;
      assert.equal(command.expectedRevision, f.state.revision);
      const next = structuredClone(f.state);
      update(next);
      next.revision++;
      return { state: next };
    } };
    const recovered = await recoverInterruptedWorkspace({ ...f, authorityStore, evidenceStore: f.harness.evidenceStore,
      commandId: 'recover', patchReceiptDigest: H, readHostEffect: async () => f.effect });
    assert.equal(transactionCount, 1);
    assert.equal(recovered.sourceDigest, f.after.digest);
    assert.deepEqual(recovered.features, frozen.features);
    assert.deepEqual(recovered.submissions, []);
    assert.deepEqual(recovered.leases, frozen.leases);
    assert.deepEqual(f.state, frozen);
    const claim = await readInterruptedWorkspaceDraft({ state: recovered, evidenceStore: f.harness.evidenceStore,
      readHostEffect: async () => f.effect });
    assert.deepEqual(claim.changedFiles, ['src/runtime.txt']);
    assert.equal(claim.patchReceiptDigest, H);
    const replay = await recoverInterruptedWorkspace({ ...f, state: recovered, authorityStore,
      evidenceStore: f.harness.evidenceStore, commandId: 'recover', readHostEffect: async () => f.effect });
    assert.equal(replay, recovered);
    assert.equal(transactionCount, 1);
    const planRun = { projectId: f.projectId, runId: 'plan', sourceDigest: H,
      metadata: { commandIntent: { target: 'V1' }, workflow: { id: 'flow' } } };
    recovered.metadata.workflow = { id: 'flow' };
    recovered.metadata.approvedPlan = { runId: 'plan', planDigest: H, artifactDigest: H,
      originalSourceDigest: H, sourceDigest: H };
    recovered.submissions = [{ featureId: 'first', inputSourceDigest: H, outputSourceDigest: f.before.digest,
      changedFiles: ['src/first.txt'], submissionDigest: H, evidenceRefs: ['first-evidence'] }];
    const result = await assessRecoveredImplementationContinuation({ planRun,
      planArtifact: { planDigest: H, artifactDigest: H }, priorRuns: [recovered],
      currentSnapshot: f.after, workspaceRoot: f.workspace, implementationFeatures: recovered.features,
      evidenceStore: f.harness.evidenceStore, readHostEffect: async () => f.effect });
    assert.equal(result.mode, 'verified-implementation-with-interrupted-draft');
    assert.deepEqual(result.submissionDigests, [H]);
    assert.equal(result.toSourceDigest, f.after.digest);
  } finally { await f.cleanup(); }
});

test('source recovery rejects ambiguous transport, wrong scope, changed binding and incomplete native proof', async () => {
  const f = await fixture();
  try {
    const mutations = [
      value => { value.state.leases[0].status = 'active'; },
      value => { value.state.dispatches.push(structuredClone(value.state.dispatches[0])); },
      value => { value.state.events.at(-1).mode = 'hard-recovery'; },
      value => { value.state.generation++; },
      value => { value.state.features[1].allowedPaths = ['elsewhere']; },
      value => { value.state.features[1].forbiddenPaths = ['src']; value.state.dispatches[0].featureSnapshot.forbiddenPaths = ['src']; },
      value => { value.effect.binding.packetDigest = 'b'.repeat(64); },
      value => { value.effect.outcome.target = 'unrelated'; },
      value => { delete value.effect.outcome.verificationRequestDigest; },
      value => { value.effect.outcome = { reason: 'preflight-reconciliation', disposition: 'not-observed', observationRequestDigest: H }; },
      value => { value.effect.outcome = { reason: 'preflight-reconciliation', disposition: 'absent-after-interrupt', target: 'agent', interruptRequestDigest: H, interruptResultDigest: H, verificationRequestDigest: H }; },
      value => { value.effect.outcome = { reason: 'preflight-reconciliation', disposition: 'already-terminal', observedAgentName: 'unrelated', observationRequestDigest: H }; },
      value => { value.effect.state = 'lease-bound'; },
      value => { value.before.files = []; },
      value => { value.after.root = resolve(f.workspace, '..'); },
      value => { value.after.files.push({ path: '../outside', sha256: H, size: 1 }); value.after.digest = digestJson(value.after.files); },
      value => { value.after.files.push({ path: 'src/private/key', sha256: H, size: 1 }); value.after.digest = digestJson(value.after.files); },
    ];
    for (const mutate of mutations) {
      const input = structuredClone({ state: f.state, before: f.before, after: f.after, effect: f.effect });
      mutate(input);
      assert.throws(() => assessInterruptedWorkspace(input), error => error.code === 'INTERRUPTED_SOURCE_RECOVERY_UNVERIFIED');
    }
  } finally { await f.cleanup(); }
});

test('a fenced missing or observed terminal Agent preserves only an unsubmitted draft', async () => {
  const f = await fixture();
  try {
    for (const outcome of [
      { reason: 'preflight-reconciliation', disposition: 'absent-after-interrupt', target: 'agent',
        observationRequestDigest: H, interruptRequestDigest: H, interruptResultDigest: H, verificationRequestDigest: H },
      { reason: 'preflight-reconciliation', disposition: 'already-terminal', observedAgentName: 'agent', observationRequestDigest: H },
    ]) {
      const assessed = assessInterruptedWorkspace({ ...f, effect: { ...f.effect, outcome } });
      assert.deepEqual(assessed.changedFiles, ['src/runtime.txt']);
      assert.equal(assessed.feature.state, 'pending');
      assert.equal(assessed.lease.status, 'superseded');
      assert.deepEqual(f.state.submissions, []);
      const authorityStore = { async transact(projectId, runId, command, update) {
        const state = structuredClone(f.state);
        update(state);
        state.revision++;
        return { state };
      } };
      const effect = { ...f.effect, outcome };
      const recovered = await recoverInterruptedWorkspace({ ...f, effect, authorityStore,
        evidenceStore: f.harness.evidenceStore, commandId: 'preserve-fenced-draft', readHostEffect: async () => effect });
      const claim = await readInterruptedWorkspaceDraft({ state: recovered,
        evidenceStore: f.harness.evidenceStore, readHostEffect: async () => effect });
      assert.deepEqual(claim.changedFiles, ['src/runtime.txt']);
      assert.deepEqual(recovered.submissions, []);
      assert.equal(recovered.features[1].state, 'pending');
    }
  } finally { await f.cleanup(); }
});
