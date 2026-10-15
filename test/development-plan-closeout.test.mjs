import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digestJson } from '../src/common/canonical.mjs';
import { captureWorkspace } from '../src/common/workspace-snapshot.mjs';
import { assertCompletedPlanCloseoutScope, closeCompletedReviewedPlan } from '../src/application/development-plan-closeout.mjs';
import { planApprovalSnapshot } from '../src/flows/delivery-lifecycle/plan-approval.mjs';
import { feature, command, makeFixture } from './test-support.mjs';

const seed = async t => {
  const fixture = await makeFixture({ profiles: ['engine-delivery'], policy: { planArchiveRoot: 'docs/versions' } });
  t.after(fixture.cleanup);
  const { harness, projectId, workspace } = fixture;
  const runId = 'plan-repair';
  const features = [feature('planner', { stage: 'version-planning', sourcePolicy: 'write' }),
    ...['one', 'two', 'three'].map((id, index, ids) => feature(id,
      { stage: 'plan-review', sourcePolicy: 'read-only' }, { allowedPaths: [], dependsOn: index ? [ids[index - 1]] : ['planner'] }))];
  const started = await harness.startRun({ projectId, runId, profileId: 'engine-delivery', features,
    profileConfig: { requireCanonicalDecision: false, requireUserCodeReview: false },
    metadata: { commandIntent: { action: 'replan', target: 'V3.9.0' } },
    executionAuthorizationEvidence: { explicitUnattended: true } }, command());
  const source = await captureWorkspace(workspace);
  const sourceEvidence = await harness.evidenceStore.put(source, { projectId, runId, epoch: 1, generation: 1, sourceDigest: source.digest });
  const finding = { id: 'PR-1', severity: 'P1', summary: 'Old source path was retained.' };
  const assessment = { id: 'PR-1', reviewSubmissionId: 'review-1',
    quotedAssessment: 'The source path correction is verified; PR-2 covers remaining producer ordering.',
    supersededBy: ['PR-2'], summary: 'The second independent review verifies the original correction and the final independent review explicitly resolves the successor blocker.' };
  const results = [
    { status: 'completed', changedFiles: [], findings: [finding], outputs: { 'plan-review': { value: { approved: false, findings: ['PR-1 [P1] old source'] } } } },
    { status: 'completed', changedFiles: [], findings: [], outputs: { 'plan-review': { value: { approved: false, findings: ['PR-2 [P1] producer order'], previousFindings: { 'PR-1': assessment.quotedAssessment } } } } },
    { status: 'completed', changedFiles: [], findings: [], checkpoints: [{ id: 'PR-2', status: 'resolved', summary: 'Producer ordering verified.', evidence: ['docs/contract.md'] }],
      outputs: { 'plan-review': { value: { approved: true, findings: [], resolvedFindings: ['PR-2'] } } } },
  ];
  const reviews = [];
  for (const [index, result] of results.entries()) {
    const featureId = features[index + 1].id;
    const evidence = await harness.evidenceStore.put({ result, inputSourceDigest: source.digest, outputSourceDigest: source.digest },
      { projectId, runId, featureId, dispatchId: `dispatch-${index}`, epoch: 1, generation: 1, sourceDigest: source.digest });
    const body = { submissionId: `review-${index}`, dispatchId: `dispatch-${index}`, featureId, epoch: 1, generation: 1,
      inputSourceDigest: source.digest, outputSourceDigest: source.digest, evidenceRefs: [evidence.ref], result };
    reviews.push({ ...body, submissionDigest: digestJson(body) });
  }
  const seeded = await harness.authorityStore.transact(projectId, runId,
    { expectedRevision: started.state.revision, commandId: 'seed-completed-plan', payload: {} }, state => {
      state.features.forEach(item => { item.state = 'completed'; });
      state.submissions = [{ featureId: 'planner', result: { status: 'completed', outputs: { plan: { value: {
        proposedFeatures: [{ id: 'engine', projectId, disposition: 'project-owned', allowedPaths: ['src'], dependsOn: [] }] } } } } }, ...reviews];
      state.findings = [{ ...finding, source: 'review', status: 'open', featureId: 'one', evidenceRefs: reviews[0].evidenceRefs }];
      state.dispatches = [{ dispatchId: 'dispatch-2', sourceDigest: source.digest, sourceSnapshotRef: sourceEvidence.ref, status: 'committed' }];
      state.status = 'closure-blocked';
    });
  const snapshot = planApprovalSnapshot(seeded.state);
  const approved = await harness.kernel.recordDecision(projectId, runId, { id: 'implementation-plan-approved', actor: 'user', decision: 'approved',
    projectId, runId, planDigest: snapshot.planDigest, artifactDigest: snapshot.artifactDigest },
  { expectedRevision: seeded.state.revision, commandId: 'approve' });
  const repair = { kind: 'reviewed-plan-closeout-repair', actor: 'operator', projectId, runId,
    planDigest: snapshot.planDigest, artifactDigest: snapshot.artifactDigest, legacyAssessments: [assessment] };
  return { ...fixture, project: await harness.projectRegistry.get(projectId), runId, repair,
    expectedRevision: approved.state.revision, commandId: 'repair-closeout', snapshot };
};

test('closeout repairs only sealed findings, preserves approval, archives and closes without starting work', async t => {
  const input = await seed(t);
  const before = await input.harness.authorityStore.read(input.projectId, input.runId);
  const preview = await closeCompletedReviewedPlan({ ...input, checkOnly: true });
  assert.deepEqual(preview.repairableIds, ['PR-1']);
  assert.equal(preview.implementationPlanReady, false);
  assert.equal((await input.harness.authorityStore.read(input.projectId, input.runId)).revision, before.revision);
  const output = await closeCompletedReviewedPlan(input);
  assert.equal(output.status, 'closed');
  assert.equal(output.featureExecutionStarted, false);
  const after = await input.harness.authorityStore.read(input.projectId, input.runId);
  assert.deepEqual(after.submissions, before.submissions);
  assert.deepEqual(after.dispatches, before.dispatches);
  assert.deepEqual(after.decisions, before.decisions);
  assert.equal(after.findings[0].status, 'resolved');
  assert.deepEqual(planApprovalSnapshot(after), input.snapshot);
  assert.equal(await readFile(output.archive.path, 'utf8'), input.snapshot.markdown);
  const replay = { ...input, expectedRevision: after.revision };
  assert.equal((await closeCompletedReviewedPlan(replay)).revision, after.revision);
  assert.equal((await closeCompletedReviewedPlan({ ...replay, checkOnly: true })).implementationPlanReady, true);
});

test('closeout rejects source drift, stale revision, unsafe work and incomplete evidence without mutations', async t => {
  const input = await seed(t);
  const original = await input.harness.authorityStore.read(input.projectId, input.runId);
  for (const change of [
    state => { state.features[0].state = 'running'; },
    state => { state.features[0].metadata.stage = 'implementation'; },
    state => { state.metadata.commandIntent.action = 'implement'; },
    state => { state.leases.push({ status: 'active' }); },
    state => { state.dispatches.push({ status: 'requested' }); },
    state => { state.decisions = []; },
    state => { state.metadata.workspace.root = resolve(input.workspace, 'other'); },
  ]) {
    const state = structuredClone(original);
    change(state);
    assert.throws(() => assertCompletedPlanCloseoutScope({ ...input, state }),
      { code: 'DEVELOPMENT_PLAN_CLOSEOUT_SCOPE_MISMATCH' });
  }
  const reject = async (overrides, code) => {
    await assert.rejects(closeCompletedReviewedPlan({ ...input, ...overrides }), { code });
    assert.equal((await input.harness.authorityStore.read(input.projectId, input.runId)).revision, input.expectedRevision);
  };
  await reject({ expectedRevision: input.expectedRevision - 1 }, 'DEVELOPMENT_PLAN_CLOSEOUT_SCOPE_MISMATCH');
  await reject({ repair: { ...input.repair, artifactDigest: 'wrong' } }, 'DEVELOPMENT_PLAN_CLOSEOUT_SCOPE_MISMATCH');
  await reject({ repair: { ...input.repair, legacyAssessments: [] } }, 'QUALITY_FINDINGS_OPEN');
  await writeFile(resolve(input.workspace, 'README.md'), 'source changed');
  await reject({}, 'IMPLEMENTATION_PLAN_SOURCE_MISMATCH');
});
