import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digestJson } from '../src/common/canonical.mjs';
import { harnessTemporaryRoot } from '../src/common/write-boundary.mjs';
import { AuthorityStore } from '../src/kernel/authority-store.mjs';
import { EvidenceStore } from '../src/kernel/evidence-store.mjs';
import { assessUnacceptedTerminalResult, assertDispatchSourceSnapshotEvidence,
  commitUnacceptedDevelopmentRetirement } from '../src/application/development-run-recovery.mjs';

const snapshot = files => ({ files, digest: digestJson(files) });
const file = (path, sha256) => ({ path, sha256, size: 1 });

test('unaccepted completion separates claimed paths from later source edits and requires a pinned scope rejection', () => {
  const before = snapshot([file('src/base.rs', 'a'.repeat(64))]);
  const after = snapshot([file('src/base.rs', 'a'.repeat(64)), file('docs/engine_design.md', 'b'.repeat(64)),
    file('docs/versions/v3/supplement.md', 'c'.repeat(64))]);
  const feature = { allowedPaths: ['src', 'docs/engine_design'], forbiddenPaths: [] };
  const result = { status: 'completed', summary: 'Original Agent claimed completion.', changedFiles: ['docs/engine_design.md'] };
  assert.deepEqual(assessUnacceptedTerminalResult({ feature, result, before, after }), {
    claimedChangedFiles: ['docs/engine_design.md'], rejectedPaths: ['docs/engine_design.md'],
    unclaimedChangedPaths: ['docs/versions/v3/supplement.md'],
  });
  assert.throws(() => assessUnacceptedTerminalResult({ feature: { ...feature, allowedPaths: ['docs/engine_design.md'] },
    result, before, after }), error => error.code === 'DEVELOPMENT_RUN_RETIREMENT_REJECTION_UNVERIFIED');
  assert.throws(() => assessUnacceptedTerminalResult({ feature, result,
    before, after: snapshot([file('src/base.rs', 'a'.repeat(64))]) }),
  error => error.code === 'DEVELOPMENT_RUN_RETIREMENT_CLAIM_DRIFT');
});

test('a Run-scoped workspace snapshot is bound to its Dispatch by the immutable source reference', async t => {
  const parent = resolve(harnessTemporaryRoot(), 'dispatch-source-snapshot-tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'case-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidenceStore = new EvidenceStore({ root, controlRoot: process.cwd() });
  const before = { protocolVersion: '1.0', root: process.cwd(), ...snapshot([file('src/base.rs', 'a'.repeat(64))]) };
  const state = { projectId: 'project', runId: 'run', epoch: 1, generation: 2, sourceDigest: before.digest,
    artifactDigest: '1'.repeat(64), policyDigest: '2'.repeat(64), pluginSetDigest: '3'.repeat(64),
    metadata: { workspace: { root: process.cwd() } } };
  const stored = await evidenceStore.put(before, { mediaType: 'application/json', projectId: state.projectId,
    runId: state.runId, epoch: state.epoch, generation: state.generation, sourceDigest: state.sourceDigest,
    artifactDigest: state.artifactDigest, policyDigest: state.policyDigest,
    pluginSetDigest: state.pluginSetDigest, labels: ['workspace-snapshot'] });
  const evidence = await evidenceStore.read(stored.ref);
  const dispatch = { dispatchId: 'dispatch-14', epoch: state.epoch, generation: state.generation,
    sourceDigest: state.sourceDigest, sourceSnapshotRef: stored.ref };
  assert.equal(evidence.metadata.featureId, null);
  assert.equal(evidence.metadata.dispatchId, null);
  assert.deepEqual(assertDispatchSourceSnapshotEvidence({ evidence, state, dispatch }), before);
  assert.throws(() => assertDispatchSourceSnapshotEvidence({ evidence, state,
    dispatch: { ...dispatch, sourceSnapshotRef: `evidence:${'f'.repeat(64)}:${'e'.repeat(64)}` } }),
  error => error.code === 'DEVELOPMENT_RUN_RETIREMENT_SOURCE_EVIDENCE_INVALID');
  assert.throws(() => assertDispatchSourceSnapshotEvidence({ evidence: { ...evidence,
    bytes: Buffer.from(JSON.stringify({ ...before, files: [] })) }, state, dispatch }),
  error => error.code === 'DEVELOPMENT_RUN_RETIREMENT_SOURCE_EVIDENCE_INVALID');
});

test('trusted retirement atomically fails the old Run without completing F-14 or changing source attribution', async t => {
  const parent = resolve(harnessTemporaryRoot(), 'unaccepted-retirement-tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'case-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authorityStore = await new AuthorityStore({ root, controlRoot: process.cwd() }).init();
  const evidenceStore = new EvidenceStore({ root, controlRoot: process.cwd() });
  const initial = { projectId: 'project', runId: 'run', status: 'running', sourceDigest: 'a'.repeat(64),
    artifactDigest: '1'.repeat(64), policyDigest: '2'.repeat(64), pluginSetDigest: '3'.repeat(64),
    epoch: 1, generation: 1, features: [
      { id: 'F-00', state: 'completed' }, { id: 'F-14', state: 'running' },
    ], leases: [{ leaseId: 'lease-14', dispatchId: 'dispatch-14', status: 'active' }],
    dispatches: [{ dispatchId: 'dispatch-14', featureId: 'F-14', status: 'assigned' }],
    submissions: [{ submissionId: 'submission-00', featureId: 'F-00', result: { status: 'completed' } }],
    evidenceRefs: ['evidence:prior'], metadata: {}, events: [] };
  const state = (await authorityStore.create(initial, { commandId: 'start' })).state;
  const evidenceBody = { kind: 'unaccepted-terminal-result-retirement', version: '1.0',
    priorAuthorityDigest: state.authorityDigest, patchReceiptDigest: 'b'.repeat(64),
    hostObservationReceipt: { receiptDigest: 'c'.repeat(64) }, originalResultDigest: 'd'.repeat(64),
    rejection: { code: 'FEATURE_PATH_NOT_ALLOWED', rejectedPaths: ['docs/engine_design.md'] },
    sourceDelta: { fromSourceDigest: state.sourceDigest, observedSourceDigest: 'e'.repeat(64),
      claimedChangedFiles: ['docs/engine_design.md'], unclaimedChangedPaths: ['docs/versions/v3/supplement.md'] } };
  const evidence = await evidenceStore.put(evidenceBody, { projectId: state.projectId, runId: state.runId,
    epoch: state.epoch, generation: state.generation, featureId: 'F-14', dispatchId: 'dispatch-14',
    sourceDigest: state.sourceDigest, artifactDigest: state.artifactDigest,
    policyDigest: state.policyDigest, pluginSetDigest: state.pluginSetDigest });
  const input = { authorityStore, evidenceStore, state, lease: state.leases[0], dispatch: state.dispatches[0], feature: state.features[1],
    evidenceRef: evidence.ref, patchReceiptDigest: 'b'.repeat(64),
    hostReceiptDigest: 'c'.repeat(64), resultDigest: 'd'.repeat(64),
    observedSourceDigest: 'e'.repeat(64), claimedChangedFiles: ['docs/engine_design.md'],
    unclaimedChangedPaths: ['docs/versions/v3/supplement.md'], commandId: 'retire-once',
    now: () => '2026-10-13T00:00:00.000Z' };
  const retired = await commitUnacceptedDevelopmentRetirement(input);
  const persisted = await authorityStore.read('project', 'run');
  assert.equal(retired.status, 'failed');
  assert.equal(persisted.sourceDigest, initial.sourceDigest);
  assert.equal(persisted.features[0].state, 'completed');
  assert.equal(persisted.features[1].state, 'blocked');
  assert.equal(persisted.submissions.length, 1);
  assert.equal(persisted.leases[0].status, 'superseded');
  assert.equal(persisted.dispatches[0].status, 'superseded');
  assert.deepEqual(persisted.metadata.terminalOutcome.evidenceRefs, [evidence.ref]);
  assert.deepEqual(await commitUnacceptedDevelopmentRetirement(input), retired);
  await assert.rejects(() => commitUnacceptedDevelopmentRetirement({ ...input, resultDigest: 'f'.repeat(64),
    commandId: 'tampered-result' }), error => error.code === 'DEVELOPMENT_RUN_RETIREMENT_EVIDENCE_INVALID');
  await assert.rejects(() => commitUnacceptedDevelopmentRetirement({ ...input, commandId: 'another-command' }),
    error => error.code === 'REVISION_CONFLICT');
});
