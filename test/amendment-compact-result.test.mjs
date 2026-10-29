import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digestJson } from '../src/common/canonical.mjs';
import { captureWorkspace } from '../src/common/workspace-snapshot.mjs';
import { materializePlanAmendment, planAmendmentReference, resolvePlanAmendmentResult } from '../src/application/plan-amendment-artifacts.mjs';
import { resolvedPlanAmendment } from '../src/flows/delivery-lifecycle/plan-amendment.mjs';
import { deliveryValueSchemas } from '../src/flows/delivery-lifecycle/contracts/index.mjs';
import { validateBusinessResult } from '../src/platform/execution/result-contract.mjs';
import { assessPlanningOutputRetirement, commitPlanningOutputRetirement } from '../src/application/development-planning-retirement.mjs';
import { verifyBlockedDraftArtifacts } from '../src/application/plan-amendment-draft-artifacts.mjs';
import { isBlockedAmendmentDraft } from '../src/application/plan-amendment-retry.mjs';
import { makeFixture } from './test-support.mjs';
import { amendmentFixture } from './fixtures/plan-amendment.mjs';

test('large materialized plans stay reference-sized through validation; native limits and pinned byte checks remain strict', async t => {
  const f = await makeFixture(); t.after(f.cleanup);
  const { revision, patch } = amendmentFixture(); patch.changes[0].value = ['contract '.repeat(40000)];
  const built = await materializePlanAmendment({ revision, patch, workspaceRoot: f.workspace });
  const value = planAmendmentReference(built);
  const result = { status: 'completed', summary: 'Reference-only result', changedFiles: built.artifacts.map(item => item.path),
    outputs: { amendment: { schemaId: 'delivery-plan-amendment-v1', value, evidenceRefs: [value.deltaRef.path] } } };
  const feature = { allowedPaths: ['docs/amend'], metadata: { stage: 'version-planning',
    outputPorts: { amendment: 'delivery-plan-amendment-v1' }, outputValueSchemas: { amendment: deliveryValueSchemas['delivery-plan-amendment-v1'] } } };
  const resolved = await resolvePlanAmendmentResult({ state: { metadata: { commandIntent: { action: 'amend' }, planRevision: revision } }, feature, result, workspaceRoot: f.workspace });
  assert(Buffer.byteLength(JSON.stringify(built.plan)) > 256 * 1024);
  assert(Buffer.byteLength(JSON.stringify(resolved.result.outputs)) < 1024);
  validateBusinessResult(resolved.result, { conversationVisible: true, feature });
  assert.deepEqual(resolvedPlanAmendment(revision, resolved.result.outputs.amendment.value, { workspaceRoot: f.workspace }), built.plan);
  assert.throws(() => validateBusinessResult({ ...result, outputs: { amendment: { ...result.outputs.amendment, value: { ...value, plan: built.plan } } } },
    { conversationVisible: true, feature }), { code: 'RESULT_OUTPUT_BUDGET_EXCEEDED' });
  const read = candidate => resolvedPlanAmendment(revision, candidate, { workspaceRoot: f.workspace });
  assert.throws(() => read({ ...value, deltaRef: { ...value.deltaRef, path: 'docs/amend/../outside.json' } }), { code: 'PLAN_AMENDMENT_REFERENCE_INVALID' });
  assert.throws(() => read({ ...value, basePlanDigest: 'f'.repeat(64) }), { code: 'PLAN_AMENDMENT_BINDING_MISMATCH' });
  await writeFile(resolve(f.workspace, value.deltaRef.path), '{}');
  assert.throws(() => read(value), { code: 'PLAN_AMENDMENT_INPUT_STALE' });
});

test('preserved unsubmitted planning output fences transport atomically without accepting completion, resetting budget, or blessing drift', async t => {
  const f = await makeFixture(); t.after(f.cleanup);
  const before = await captureWorkspace(f.workspace);
  const { revision, patch } = amendmentFixture(); patch.changes[0].value = ['contract '.repeat(40000)];
  const built = await materializePlanAmendment({ revision, patch, workspaceRoot: f.workspace });
  const after = await captureWorkspace(f.workspace);
  const feature = { id: 'planner', state: 'running', allowedPaths: ['docs/amend'], forbiddenPaths: [], metadata: { stage: 'version-planning' } };
  const initial = { projectId: f.projectId, runId: 'draft', status: 'running', epoch: 1, generation: 1,
    sourceDigest: before.digest, artifactDigest: '1'.repeat(64), policyDigest: '2'.repeat(64), pluginSetDigest: '3'.repeat(64),
    metadata: { workspace: { root: f.workspace }, commandIntent: { action: 'amend' }, planRevision: revision },
    features: [feature], findings: [], attempts: { budget: { used: 21, limit: 21 } }, submissions: [], evidenceRefs: [], events: [] };
  const input = await f.harness.evidenceStore.put(before, { projectId: f.projectId, runId: 'draft', epoch: 1, generation: 1, sourceDigest: before.digest });
  const dispatch = { dispatchId: 'planning', featureId: feature.id, sourceSnapshotRef: input.ref, featureSnapshot: feature, status: 'assigned' };
  const lease = { leaseId: 'lease', dispatchId: dispatch.dispatchId, status: 'active' };
  const state = (await f.harness.authorityStore.create({ ...initial, dispatches: [dispatch], leases: [lease] }, { commandId: 'start' })).state;
  const result = { status: 'completed', summary: 'Native draft remains unaccepted', changedFiles: built.artifacts.map(item => item.path),
    outputs: { amendment: { schemaId: 'delivery-plan-amendment-v1', value: planAmendmentReference(built), evidenceRefs: ['native'] } } };
  const assessment = assessPlanningOutputRetirement({ state, feature, result, before, after });
  const drift = structuredClone(after); drift.files.push({ path: 'src/unclaimed', sha256: 'x', size: 1 });
  assert.throws(() => assessPlanningOutputRetirement({ state, feature, result, before, after: drift }), { code: 'DEVELOPMENT_PLANNING_RETIREMENT_SOURCE_DRIFT' });
  const record = { kind: 'unaccepted-planning-output', version: '1.0', priorAuthorityDigest: state.authorityDigest,
    patchReceiptDigest: '4'.repeat(64), originalResult: result, originalResultDigest: digestJson(result), sourceSnapshotRef: input.ref,
    rejection: { code: 'RESULT_OUTPUT_BUDGET_EXCEEDED', expandedBytes: assessment.expandedBytes }, changedFiles: assessment.changedFiles, outputSnapshot: after };
  const evidence = await f.harness.evidenceStore.put(record, { projectId: f.projectId, runId: state.runId, epoch: 1, generation: 1,
    featureId: feature.id, dispatchId: dispatch.dispatchId, sourceDigest: state.sourceDigest, artifactDigest: state.artifactDigest });
  const args = { authorityStore: f.harness.authorityStore, evidenceStore: f.harness.evidenceStore, state, lease, dispatch, feature,
    evidenceRef: evidence.ref, commandId: 'preserve' };
  const saved = await commitPlanningOutputRetirement(args);
  assert.equal(saved.state.status, 'ready'); assert.equal(saved.state.submissions.length, 0);
  assert.deepEqual(saved.state.attempts, state.attempts); assert.equal(saved.state.sourceDigest, state.sourceDigest);
  assert.equal(saved.state.leases[0].status, 'superseded'); assert.equal(isBlockedAmendmentDraft(saved.state), true);
  assert.equal((await commitPlanningOutputRetirement(args)).reused, true);
  const verify = snapshot => verifyBlockedDraftArtifacts({ drafts: [saved.state], snapshot, evidenceStore: f.harness.evidenceStore, artifactRoot: 'docs/amend' });
  assert.equal((await verify(after)).size, result.changedFiles.length);
  const changed = structuredClone(after); changed.files.find(item => result.changedFiles.includes(item.path)).sha256 = 'tampered';
  await assert.rejects(verify(changed), { code: 'PLAN_AMENDMENT_DRAFT_ARTIFACT_CHANGED' });
});

test('canonical formatted artifact bytes have their own read bound while the compact delta limit still applies', async t => {
  const f = await makeFixture(); t.after(f.cleanup);
  const { revision, patch } = amendmentFixture();
  let nested = Array(60000).fill('x');
  for (let depth = 0; depth < 12; depth += 1) nested = { detail: nested };
  patch.changes[0].value = [nested];
  assert(Buffer.byteLength(JSON.stringify(patch)) < 2 * 1024 * 1024);
  const built = await materializePlanAmendment({ revision, patch, workspaceRoot: f.workspace });
  const ref = planAmendmentReference(built);
  const { stat } = await import('node:fs/promises');
  assert((await stat(resolve(f.workspace, ref.deltaRef.path))).size > 2 * 1024 * 1024);
  assert.deepEqual(resolvedPlanAmendment(revision, ref, { workspaceRoot: f.workspace }), built.plan);
});
