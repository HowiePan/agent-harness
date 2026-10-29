import test from 'node:test';
import assert from 'node:assert/strict';
import { digestJson } from '../src/common/canonical.mjs';
import { resolveCarryoverApproval, readCarryoverApprovalSnapshot } from '../src/application/implementation-carryover-approval.mjs';
import { verifyAmendmentBaselines } from '../src/application/plan-amendment-baseline.mjs';
import { expandApprovedImplementation } from '../src/flows/delivery-lifecycle/approved-implementation.mjs';
import { implementationGraphDigest } from '../src/kernel/completion-carryover.mjs';
import { implementNode } from '../src/flows/delivery-lifecycle/nodes/implement/index.mjs';

const fixture = () => {
  const sourceDigest = 'a'.repeat(64);
  const original = { projectId: 'project', runId: 'approved-plan', planDigest: 'b'.repeat(64),
    artifactDigest: 'c'.repeat(64), sourceDigest: 'd'.repeat(64), originalSourceDigest: 'e'.repeat(64),
    typedPlan: { proposedFeatures: ['A00', 'A01', 'layout'].map((id, index, ids) => ({
      id, projectId: 'project', disposition: 'project-owned', dependsOn: index ? [ids[index - 1]] : [],
      contracts: ['approved contract'], verification: ['approved check'], allowedPaths: ['src'],
    })) }, approvalDecision: { id: 'implementation-plan-approved', actor: 'user', decision: 'approved' },
    sourceCompatibility: { mode: 'verified-prior-implementation', priorRunId: 'earlier-run' } };
  const input = { projectId: 'project', runId: 'replacement', sourceDigest,
    completionCarryover: { priorRunId: 'prior', carryoverDigest: 'f'.repeat(64) },
    metadata: { lifecyclePlanDigest: '1'.repeat(64) } };
  const prior = { projectId: 'project', runId: 'prior', sourceDigest, status: 'superseded', metadata: {
    approvedPlan: original, supersededByRunId: input.runId, supersedePlanDigest: input.metadata.lifecyclePlanDigest,
    completionCarryover: { plan: { replacementRunId: input.runId,
      replacementPlanDigest: input.metadata.lifecyclePlanDigest, sourceDigest,
      carryoverDigest: input.completionCarryover.carryoverDigest } },
  } };
  const currentApproval = { ...structuredClone(original), sourceDigest,
    sourceCompatibility: { mode: 'verified-prior-implementation', priorRunId: 'prior', toSourceDigest: sourceDigest } };
  return { input, prior, currentApproval, original };
};

test('fresh source assessment preserves the sealed approval and exact expanded Feature graph', () => {
  const f = fixture();
  const parent = { id: 'implement/V1', logicalRoot: 'implement:V1', executionClass: 'agent-reasoning',
    task: implementNode.task, dependsOn: [], allowedPaths: ['src'], forbiddenPaths: ['.git'], contracts: [],
    metadata: { stage: 'implementation', target: 'V1', workflow: { nodeId: 'implement' } } };
  const expand = approvalBinding => expandApprovedImplementation({ features: [parent],
    typedPlan: f.original.typedPlan, projectId: 'project', approvalBinding });
  const sealed = implementationGraphDigest(expand(f.original));
  assert.notEqual(implementationGraphDigest(expand(f.currentApproval)), sealed);
  const resolved = resolveCarryoverApproval(f);
  assert.equal(implementationGraphDigest(expand(resolved)), sealed);
  assert.deepEqual(resolved, f.original);
  assert.notEqual(resolved, f.original);
  assert.equal(f.currentApproval.sourceDigest, f.input.sourceDigest);
  const alteredGraph = expand(resolved);
  alteredGraph[0].allowedPaths.push('outside');
  assert.notEqual(implementationGraphDigest(alteredGraph), sealed);
});

test('carry-over rejects changed approval identity, user Decision and typed proposal bytes', () => {
  for (const field of ['projectId', 'runId', 'planDigest', 'artifactDigest', 'originalSourceDigest',
    'approvalDecision', 'typedPlan']) {
    const f = fixture();
    f.currentApproval[field] = { changed: field };
    assert.throws(() => resolveCarryoverApproval(f), error => error.code === 'CARRYOVER_APPROVAL_IDENTITY_CHANGED');
  }
  const f = fixture();
  delete f.currentApproval.approvalDecision;
  assert.throws(() => resolveCarryoverApproval(f), error => error.code === 'CARRYOVER_APPROVAL_IDENTITY_CHANGED');
});

test('carry-over approval requires the exact retired claim and unchanged authoritative source', () => {
  const mutations = [f => { f.prior.status = 'running'; }, f => { f.prior.projectId = 'other'; },
    f => { f.prior.runId = 'other'; }, f => { f.prior.sourceDigest = '0'.repeat(64); },
    f => { f.prior.metadata.supersededByRunId = 'other'; },
    f => { f.prior.metadata.supersedePlanDigest = '0'.repeat(64); },
    ...['replacementRunId', 'replacementPlanDigest', 'carryoverDigest', 'sourceDigest'].map(field =>
      f => { f.prior.metadata.completionCarryover.plan[field] = 'different'; })];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    assert.throws(() => resolveCarryoverApproval(f), error => error.code === 'CARRYOVER_APPROVAL_CLAIM_MISMATCH');
  }
  const f = fixture();
  const before = digestJson(f);
  resolveCarryoverApproval(f);
  assert.equal(digestJson(f), before);
});

const snapshotFixture = () => {
  const f = fixture();
  const files = [{ path: 'src/owner.mjs', sha256: '2'.repeat(64), size: 10 }];
  const snapshot = { protocolVersion: '1.0', root: '/registered-project', files, digest: digestJson(files) };
  f.original.sourceDigest = snapshot.digest;
  f.currentSnapshot = { ...snapshot, files: [{ ...files[0], sha256: '3'.repeat(64) }], digest: f.input.sourceDigest };
  f.prior.dispatches = [{ sourceDigest: snapshot.digest, sourceSnapshotRef: 'evidence:start', epoch: 1, generation: 1 }];
  const record = { metadata: { ref: 'evidence:start', projectId: 'project', runId: 'prior',
    sourceDigest: snapshot.digest, epoch: 1, generation: 1, featureId: null, dispatchId: null,
    mediaType: 'application/json', labels: ['workspace-snapshot'] }, bytes: Buffer.from(JSON.stringify(snapshot)) };
  f.evidenceStore = { read: async ref => { assert.equal(ref, 'evidence:start'); return record; } };
  return { ...f, record, snapshot };
};

test('amended carry-over verifies its original preparation snapshot while retaining current-source guard', async () => {
  const f = snapshotFixture();
  const retired = { projectId: 'project', runId: 'retired-before-amend', status: 'failed', sourceDigest: f.snapshot.digest,
    metadata: {}, features: [] };
  f.authorityStore = { read: async () => retired };
  const read = f.evidenceStore.read;
  f.evidenceStore.read = async ref => ref === 'evidence:amend-base'
    ? { bytes: Buffer.from(JSON.stringify(f.snapshot)) } : read(ref);
  const planRun = { projectId: 'project', runId: 'approved-plan', metadata: { planRevision: {
    amendmentScope: { artifactRoot: 'docs/amend' }, implementationBaselines: [{ runId: retired.runId,
      snapshotEvidenceRef: 'evidence:amend-base', sourceDigest: f.snapshot.digest, preparationPaths: [], completed: [] }] } } };
  const typedPlan = { amendment: { documentBindings: [], affectedFeatureIds: [] } };
  const verify = snapshot => verifyAmendmentBaselines({ ...f, planRun, typedPlan, snapshot });
  await assert.rejects(verify(f.currentSnapshot), { code: 'PLAN_AMENDMENT_BASELINE_SOURCE_CHANGED' });
  const original = await readCarryoverApprovalSnapshot(f);
  assert.equal(original.digest, f.snapshot.digest);
  assert.notEqual(original.digest, f.currentSnapshot.digest);
  assert.deepEqual(await verify(original), { completedProposalIds: [], completedProposals: [], progress: {} });
  f.currentSnapshot.digest = 'changed-workspace';
  await assert.rejects(readCarryoverApprovalSnapshot(f), { code: 'CARRYOVER_WORKSPACE_SOURCE_STALE' });
});

test('carry-over amendment source rejects wrong context, missing evidence and changed snapshot bytes', async () => {
  const mutations = [f => { f.record.metadata.runId = 'unrelated'; }, f => { f.record.metadata.projectId = 'other'; },
    f => { f.record.metadata.generation = 2; }, f => { f.record.metadata.sourceDigest = 'other'; },
    f => { f.record.metadata.featureId = 'not-a-run-snapshot'; }, f => { f.record.metadata.labels = []; },
    f => { f.record.bytes = Buffer.from(JSON.stringify({ ...f.snapshot, root: '/other-project' })); },
    f => { f.record.bytes = Buffer.from(JSON.stringify({ ...f.snapshot, files: [] })); }];
  for (const mutate of mutations) {
    const f = snapshotFixture(); mutate(f);
    await assert.rejects(readCarryoverApprovalSnapshot(f), { code: 'CARRYOVER_APPROVAL_SOURCE_EVIDENCE_INVALID' });
  }
  const f = snapshotFixture(); f.prior.dispatches = [];
  await assert.rejects(readCarryoverApprovalSnapshot(f), { code: 'CARRYOVER_APPROVAL_SOURCE_EVIDENCE_REQUIRED' });
});

test('amendment source follows only the sealed inbound carry-over chain across multiple patches', async () => {
  const f = snapshotFixture();
  const parent = { ...structuredClone(f.prior), runId: 'first-implementation',
    metadata: { supersededByRunId: f.prior.runId, supersedePlanDigest: 'middle-plan', completionCarryover: {
      plan: { replacementRunId: f.prior.runId, replacementPlanDigest: 'middle-plan', carryoverDigest: 'middle-carry' } } } };
  f.prior.metadata.lifecyclePlanDigest = 'middle-plan';
  f.prior.dispatches = [];
  f.prior.events = [{ type: 'feature.completion-carried-over', priorRunId: parent.runId, carryoverDigest: 'middle-carry' }];
  f.authorityStore = { read: async (project, run) => { assert.equal(project, 'project'); assert.equal(run, parent.runId); return parent; } };
  f.record.metadata.runId = parent.runId;
  assert.equal((await readCarryoverApprovalSnapshot(f)).digest, f.snapshot.digest);
  parent.metadata.completionCarryover.plan.carryoverDigest = 'broken-link';
  await assert.rejects(readCarryoverApprovalSnapshot(f), { code: 'CARRYOVER_APPROVAL_SOURCE_EVIDENCE_INVALID' });
});
