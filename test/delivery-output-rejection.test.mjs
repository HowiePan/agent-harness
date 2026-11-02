import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digestJson, sha256 } from '../src/common/canonical.mjs';
import { fingerprintDeliveryPaths } from '../src/application/delivery-paths.mjs';
import { executeDeliveryCheck } from '../src/application/delivery-verification.mjs';
import { assertDeliveryOutputRejection, inspectDeliveryOutputRejection } from '../src/application/delivery-output-rejection.mjs';
import { assessUnacceptedTerminalResult, commitUnacceptedDevelopmentRetirement } from '../src/application/development-run-recovery.mjs';
import { makeFixture } from './test-support.mjs';
import { captureAmendmentBaselines, verifyAmendmentBaselines } from '../src/application/plan-amendment-baseline.mjs';

const linkedOutput = async f => {
  await mkdir(resolve(f.workspace, '.proof'));
  await mkdir(resolve(f.workspace, 'cache-target'));
  await writeFile(resolve(f.workspace, '.proof/00-history.bin'), Buffer.alloc(1024));
  await symlink(resolve(f.workspace, 'cache-target'), resolve(f.workspace, '.proof/zz-cache'), process.platform === 'win32' ? 'junction' : 'dir');
  const check = { id: 'owner-public', inputs: ['README.md'], outputs: ['.proof'],
    command: [process.execPath, '-e', 'process.exit(99)'], cacheable: false };
  return { id: 'F-owner', allowedPaths: ['src'], forbiddenPaths: [], metadata: { deliveryBatch: { checks: [check] } } };
};

test('delivery fingerprints preserve existing byte digests and validate late links before any artifact hashing or execution', async t => {
  const f = await makeFixture(); t.after(f.cleanup);
  await mkdir(resolve(f.workspace, 'proof'));
  await writeFile(resolve(f.workspace, 'proof/result.json'), 'proof');
  assert.equal(await fingerprintDeliveryPaths(f.workspace, ['proof', 'missing']),
    digestJson([['missing', null], ['proof', 'directory'], ['proof/result.json', sha256('proof')]]));
  const feature = await linkedOutput(f);
  const events = [];
  await assert.rejects(executeDeliveryCheck({ check: feature.metadata.deliveryBatch.checks[0], workspaceRoot: f.workspace,
    dataRoot: f.dataRoot, controlRoot: f.harness.controlRoot, evidenceStore: f.harness.evidenceStore,
    onProgress: event => events.push(event) }), { code: 'MANAGED_PATH_LINK_FORBIDDEN' });
  assert.ok(events.some(event => event.phase === 'path-inspection-started'));
  assert.ok(!events.some(event => ['fingerprint-started', 'started', 'process-started'].includes(event.phase)));
});

test('output retirement requires the exact current link and immutable check; it never accepts an otherwise valid completion', async t => {
  const f = await makeFixture(); t.after(f.cleanup);
  const feature = await linkedOutput(f);
  const rejection = await inspectDeliveryOutputRejection({ feature, workspaceRoot: f.workspace });
  assert.equal(rejection.path, '.proof/zz-cache');
  const before = { files: [], digest: digestJson([]) };
  const files = [{ path: 'src/owner.rs', sha256: 'a'.repeat(64), size: 1 }];
  const after = { files, digest: digestJson(files) };
  const result = { status: 'completed', summary: 'Native owner implementation.', changedFiles: ['src/owner.rs'] };
  const args = { feature, result, before, after, workspaceRoot: f.workspace };
  assert.throws(() => assessUnacceptedTerminalResult(args), { code: 'DEVELOPMENT_RUN_RETIREMENT_REJECTION_UNVERIFIED' });
  const assessed = assessUnacceptedTerminalResult({ ...args, outputRejection: rejection });
  assert.deepEqual(assessed.claimedChangedFiles, result.changedFiles);
  assert.deepEqual(assessed.rejectedPaths, []);
  assert.deepEqual(assessed.unclaimedChangedPaths, []);
  for (const forged of [{ ...rejection, checkDigest: 'f'.repeat(64) }, { ...rejection, path: 'README.md' },
    { ...rejection, checkId: 'another-check' }]) {
    assert.throws(() => assertDeliveryOutputRejection({ feature, rejection: forged, workspaceRoot: f.workspace }),
      { code: 'DEVELOPMENT_RUN_RETIREMENT_REJECTION_UNVERIFIED' });
  }
  await unlink(resolve(f.workspace, rejection.path));
  assert.throws(() => assessUnacceptedTerminalResult({ ...args, outputRejection: rejection }),
    { code: 'DEVELOPMENT_RUN_RETIREMENT_REJECTION_UNVERIFIED' });
});

test('verified output rejection retires exactly one Lease without a completion or a budget reset', async t => {
  const f = await makeFixture(); t.after(f.cleanup);
  const feature = { ...await linkedOutput(f), state: 'running' };
  const rejection = await inspectDeliveryOutputRejection({ feature, workspaceRoot: f.workspace });
  const initial = { projectId: f.projectId, runId: 'output-retirement', status: 'running', epoch: 1, generation: 1,
    sourceDigest: 'a'.repeat(64), artifactDigest: null, policyDigest: null, pluginSetDigest: null,
    metadata: { workspace: { root: f.workspace } }, features: [{ id: 'F-completed', state: 'completed' }, feature],
    leases: [{ leaseId: 'lease', dispatchId: 'dispatch', status: 'active' }],
    dispatches: [{ dispatchId: 'dispatch', featureId: feature.id, status: 'assigned' }],
    attempts: { [feature.id]: 7 }, submissions: [], evidenceRefs: [], events: [] };
  const state = (await f.harness.authorityStore.create(initial, { commandId: 'start-output-retirement' })).state;
  const originalResult = { status: 'completed', summary: 'Observed native completion.', changedFiles: ['src/owner.rs'] };
  const files = [{ path: 'src/owner.rs', sha256: 'f'.repeat(64), size: 1 }];
  const outputSnapshot = { protocolVersion: '1.0', root: f.workspace, files, digest: digestJson(files) };
  const body = { kind: 'unaccepted-terminal-result-retirement', version: '1.0', priorAuthorityDigest: state.authorityDigest,
    patchReceiptDigest: 'b'.repeat(64), hostObservationReceipt: { receiptDigest: 'c'.repeat(64) },
    originalResult, originalResultDigest: digestJson(originalResult), rejection,
    sourceDelta: { fromSourceDigest: state.sourceDigest, observedSourceDigest: outputSnapshot.digest, observedSnapshot: outputSnapshot,
      claimedChangedFiles: originalResult.changedFiles, unclaimedChangedPaths: [] } };
  const evidence = await f.harness.evidenceStore.put(body, { projectId: f.projectId, runId: state.runId,
    epoch: 1, generation: 1, featureId: feature.id, dispatchId: 'dispatch', sourceDigest: state.sourceDigest,
    artifactDigest: null, policyDigest: null, pluginSetDigest: null });
  const input = { authorityStore: f.harness.authorityStore, evidenceStore: f.harness.evidenceStore, state,
    lease: state.leases[0], dispatch: state.dispatches[0], feature, evidenceRef: evidence.ref,
    patchReceiptDigest: body.patchReceiptDigest, hostReceiptDigest: body.hostObservationReceipt.receiptDigest,
    resultDigest: body.originalResultDigest, observedSourceDigest: body.sourceDelta.observedSourceDigest,
    claimedChangedFiles: originalResult.changedFiles, unclaimedChangedPaths: [], commandId: 'retire-output-once' };
  const retired = await commitUnacceptedDevelopmentRetirement(input);
  const persisted = await f.harness.authorityStore.read(f.projectId, state.runId);
  assert.equal(retired.status, 'failed');
  assert.equal(persisted.leases[0].status, 'superseded');
  assert.equal(persisted.features[0].state, 'completed');
  assert.equal(persisted.features[1].state, 'blocked');
  assert.equal(persisted.features[1].blocker.code, rejection.code);
  assert.deepEqual(persisted.attempts, initial.attempts);
  assert.deepEqual(persisted.submissions, []);
  assert.equal(persisted.sourceDigest, initial.sourceDigest);
  assert.deepEqual(await commitUnacceptedDevelopmentRetirement(input), retired);
  const revision = { affectedImplementationRuns: [{ runId: state.runId }], amendmentScope: {
    artifactRoot: 'docs/amend', baselineCompatibilityPaths: [] } };
  const capture = snapshot => captureAmendmentBaselines({ states: [persisted], revision, snapshot,
    evidenceStore: f.harness.evidenceStore, project: {} });
  const baselines = await capture(outputSnapshot);
  assert.equal(baselines[0].snapshotKind, 'unaccepted-result-output');
  assert.equal(baselines[0].sourceDigest, initial.sourceDigest);
  assert.equal(baselines[0].outputSnapshot.digest, outputSnapshot.digest);
  assert.deepEqual(baselines[0].completed, []);
  revision.implementationBaselines = baselines;
  const inherited = await verifyAmendmentBaselines({ planRun: { projectId: f.projectId, runId: 'amend', metadata: { planRevision: revision } },
    typedPlan: { amendment: { documentBindings: [], affectedFeatureIds: [] } }, snapshot: outputSnapshot,
    authorityStore: f.harness.authorityStore, evidenceStore: f.harness.evidenceStore });
  assert.deepEqual(inherited.completedProposalIds, []);
  const drift = structuredClone(outputSnapshot); drift.files[0].sha256 = '0'.repeat(64); drift.digest = digestJson(drift.files);
  await assert.rejects(capture(drift), { code: 'PLAN_AMENDMENT_BASELINE_SOURCE_CHANGED' });
  const unclaimed = structuredClone(body); unclaimed.sourceDelta.unclaimedChangedPaths = ['src/unknown.rs'];
  const changed = await f.harness.evidenceStore.put(unclaimed, { projectId: f.projectId, runId: state.runId,
    epoch: 1, generation: 1, featureId: feature.id, dispatchId: 'dispatch', sourceDigest: state.sourceDigest,
    artifactDigest: null, policyDigest: null, pluginSetDigest: null });
  const forged = structuredClone(persisted); forged.metadata.unacceptedTerminalResult.evidenceRef = changed.ref; forged.evidenceRefs.push(changed.ref);
  await assert.rejects(captureAmendmentBaselines({ states: [forged], revision, snapshot: outputSnapshot,
    evidenceStore: f.harness.evidenceStore, project: {} }), { code: 'PLAN_AMENDMENT_BASELINE_EVIDENCE_INVALID' });
});
