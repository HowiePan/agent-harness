import test from 'node:test';
import assert from 'node:assert/strict';
import { digestJson, withoutKeys } from '../src/common/canonical.mjs';
import { rejectedAmendmentDraftEvidence, selectAmendmentRetry, matchesAmendmentRetry } from '../src/application/plan-amendment-retry.mjs';
import { verifyBlockedDraftArtifacts } from '../src/application/plan-amendment-draft-artifacts.mjs';
import { amendmentFixture } from './fixtures/plan-amendment.mjs';
import { validateFinding } from '../src/kernel/quality.mjs';
import { carryAmendmentReviewFindings } from '../src/application/plan-amendment-finding-carryover.mjs';
import { planReviewResolutionCandidates, verifyPlanReviewResolutionEvidence } from '../src/application/plan-review-reconciliation.mjs';

const fixture = () => {
  const { revision } = amendmentFixture();
  const intent = { action: 'amend', selector: 'bounded', workflowId: 'delivery', target: 'V1' };
  const request = { target: 'V1', amendmentScope: revision.amendmentScope };
  revision.changeRequestDigest = digestJson(request);
  const file = (path, hash) => ({ path, sha256: hash, size: 1 });
  const snapshot = files => ({ root: process.cwd(), files, digest: digestJson(files) });
  const input = snapshot([file('src/runtime', 'base')]);
  const candidate = snapshot([file('docs/amend/candidate.json', 'candidate'), ...input.files]);
  const final = snapshot([candidate.files[0], file('docs/amend/fix.json', 'fix'), ...input.files]);
  const blocker = { kind: 'protected', code: 'PLAN_AMENDMENT_TOO_LARGE', summary: 'Size bound' };
  const features = [{ id: 'planner', metadata: { stage: 'version-planning' }, state: 'completed' },
    { id: 'review', metadata: { stage: 'plan-review' }, state: 'completed' },
    { id: 'repair', metadata: { stage: 'version-planning' }, state: 'blocked', blocker }];
  const results = [
    { status: 'completed', changedFiles: ['docs/amend/candidate.json'], outputs: { amendment: { value: {
      version: 'plan-amendment/1', basePlanDigest: revision.parentPlanDigest,
      changeRequestDigest: revision.changeRequestDigest, deltaRef: { path: 'docs/amend/candidate.json', sha256: 'a'.repeat(64) } } } } },
    { status: 'completed', changedFiles: [], findings: ['mapping', 'inputs'].map(id => ({
      id, severity: 'P1', summary: `Correct ${id}`, affectedPaths: ['docs/amend/candidate.json'], evidence: ['source declaration'] })), outputs: { 'plan-review': { value: {
      approved: false, findings: ['mapping', 'inputs'], basePlanDigest: revision.parentPlanDigest,
      deltaDigest: 'd'.repeat(64), reviewedFeatureIds: revision.amendmentScope.featureIds } } } },
    { status: 'blocked', failureClass: 'protected-plan-blocker', blocker, changedFiles: ['docs/amend/fix.json'] },
  ];
  const submissions = results.map((result, index) => {
    const value = { submissionId: `s${index}`, featureId: features[index].id, dispatchId: `d${index}`,
      result, changedFiles: result.changedFiles, inputSourceDigest: index ? candidate.digest : input.digest,
      outputSourceDigest: index === 2 ? final.digest : candidate.digest, evidenceRefs: [`e${index}`] };
    return { ...value, submissionDigest: digestJson(value) };
  });
  const dispatches = submissions.map((row, index) => ({ dispatchId: row.dispatchId, featureId: row.featureId,
    status: 'committed', submissionId: row.submissionId, sourceSnapshotRef: `input${index}`,
    featureSnapshot: features[index] }));
  const state = { projectId: 'project', runId: 'draft', status: 'ready', revision: 29,
    authorityDigest: 'e'.repeat(64), sourceDigest: final.digest, artifactDigest: '1'.repeat(64),
    metadata: { commandIntent: intent, lifecyclePlanDigest: 'f'.repeat(64), planRevision: revision },
    decisions: [], findings: results[1].findings.map(finding => validateFinding({ ...finding,
      source: 'review', status: 'open', featureId: 'review', evidenceRefs: ['e1'], openedAt: 'original' })),
    leases: [], features, submissions, dispatches,
    attempts: { progress: { used: 21, limit: 21, exhausted: true, records: ['retained'] } } };
  const records = {};
  submissions.forEach((row, index) => {
    const metadata = { projectId: state.projectId, runId: state.runId, featureId: row.featureId,
      dispatchId: row.dispatchId, sourceDigest: row.inputSourceDigest };
    const source = index ? candidate : input;
    records[`input${index}`] = { metadata, bytes: Buffer.from(JSON.stringify(source)) };
    records[`e${index}`] = { metadata, bytes: Buffer.from(JSON.stringify({ result: row.result,
      sourceSnapshotRef: `input${index}`, inputSourceDigest: row.inputSourceDigest, outputSourceDigest: row.outputSourceDigest })) };
  });
  const args = { states: [state], intent, parentRunId: revision.parentRunId, parentPlanDigest: revision.parentPlanDigest,
    request, scope: revision.amendmentScope, artifactDigest: '2'.repeat(64) };
  return { state, args, records, final };
};

test('runtime repair retries only the exact rejected amendment and retains feedback and counters', () => {
  const { state, args } = fixture();
  const before = digestJson(state);
  assert(rejectedAmendmentDraftEvidence(state));
  const ref = selectAmendmentRetry(args);
  assert.deepEqual(ref.preservedDraft.rejectedReview.value.findings, ['mapping', 'inputs']);
  assert.deepEqual(ref.preservedDraft.openFindings, state.findings);
  assert.deepEqual(ref.preservedDraft.correctedDraft.changedFiles, ['docs/amend/fix.json']);
  assert.equal(ref.preservedDraft.acceptance, 'unaccepted-requires-planning-and-review');
  const plan = { harness: { artifactDigest: args.artifactDigest }, intent: { ...args.intent,
    planRevision: { ...state.metadata.planRevision, replacesAmendment: ref } } };
  assert(matchesAmendmentRetry(state, plan));
  assert.equal(selectAmendmentRetry({ ...args, artifactDigest: state.artifactDigest }), null);
  assert.equal(digestJson(state), before);
  for (const mutate of [
    row => row.leases.push({ status: 'active' }),
    row => row.findings.push({ status: 'open' }),
    row => { row.findings[0].summary = 'unverified change'; },
    row => { row.findings[0].evidenceRefs = ['different']; },
    row => row.decisions.push({ id: 'implementation-plan-approved', decision: 'approved' }),
    row => { row.submissions[1].result.outputs['plan-review'].value.approved = true; },
    row => { row.submissions[2].result.blocker.code = 'DIFFERENT'; },
    row => { row.sourceDigest = 'a'.repeat(64); },
    row => { row.dispatches[1].status = 'requested'; },
  ]) {
    const changed = structuredClone(state); mutate(changed);
    assert.throws(() => selectAmendmentRetry({ ...args, states: [changed] }), { code: 'PLAN_AMENDMENT_RETRY_UNSAFE' });
  }
  assert.throws(() => selectAmendmentRetry({ ...args, request: { ...args.request, summary: 'changed' } }),
    { code: 'PLAN_AMENDMENT_RETRY_UNSAFE' });
});

test('carried planning Findings remain open until a fresh review resolves each exact ID with sealed evidence', async () => {
  const { state: prior, args, records } = fixture();
  const ref = selectAmendmentRetry(args);
  const plan = { planDigest: 'plan', harness: { artifactDigest: args.artifactDigest }, intent: { ...args.intent,
    planRevision: { ...prior.metadata.planRevision, replacesAmendment: ref } } };
  const state = { projectId: prior.projectId, runId: 'replacement', revision: 1, findings: [], submissions: [],
    artifactDigest: args.artifactDigest, metadata: { lifecyclePlanDigest: plan.planDigest,
      commandIntent: plan.intent, planRevision: plan.intent.planRevision }, features: [] };
  let recorded = 0;
  const input = { state, plan, authorityStore: { read: async () => prior },
    evidenceStore: { read: async ref => records[ref] }, commandId: 'retry', kernel: {
      recordFinding: async (projectId, runId, finding, command) => {
        assert.equal(command.expectedRevision, state.revision);
        state.findings.push(validateFinding({ ...finding, status: 'open', openedAt: 'new' }));
        state.revision += 1; recorded += 1; return { state };
      } } };
  await carryAmendmentReviewFindings(input);
  await carryAmendmentReviewFindings(input);
  assert.equal(recorded, 2);
  assert(state.findings.every(row => row.status === 'open'));
  assert(prior.findings.every(row => row.status === 'open'));
  const result = { status: 'completed', changedFiles: [], findings: [], checkpoints: [],
    outputs: { 'plan-review': { value: { approved: true, findings: [] } } } };
  const review = { submissionId: 'fresh', featureId: 'fresh-review', dispatchId: 'fresh-dispatch',
    result, evidenceRefs: ['fresh-evidence'], inputSourceDigest: 'new-source', outputSourceDigest: 'new-source' };
  state.features.push({ id: review.featureId, state: 'completed', allowedPaths: [],
    metadata: { stage: 'plan-review', sourcePolicy: 'read-only' }, dependsOn: [] });
  state.submissions.push(review);
  assert.deepEqual(planReviewResolutionCandidates(state), []);
  result.outputs['plan-review'].value.resolvedFindings = ['mapping', 'inputs'];
  result.checkpoints.push({ id: 'mapping', status: 'resolved', summary: 'Exact contract mapping verified', evidence: ['contract'] });
  assert.deepEqual(planReviewResolutionCandidates(state).map(row => row.id), ['mapping']);
  result.checkpoints.push({ id: 'inputs', status: 'resolved', summary: 'Complete inputs verified', evidence: ['checks'] });
  review.submissionDigest = digestJson(review);
  records['fresh-evidence'] = { metadata: { projectId: state.projectId, runId: state.runId,
    featureId: review.featureId, dispatchId: review.dispatchId }, bytes: Buffer.from(JSON.stringify({ result,
      inputSourceDigest: review.inputSourceDigest, outputSourceDigest: review.outputSourceDigest })) };
  const candidates = planReviewResolutionCandidates(state);
  assert.equal(candidates.length, 2);
  await verifyPlanReviewResolutionEvidence(state, candidates, input.evidenceStore);
  records.e1.bytes = Buffer.from('{}');
  await assert.rejects(verifyPlanReviewResolutionEvidence(state, candidates, input.evidenceStore),
    { code: 'PLAN_REVIEW_EVIDENCE_MISMATCH' });
});

test('rejected candidate and correction bytes need original committed evidence; no artifact wildcard', async () => {
  const { state, records, final } = fixture();
  const evidenceStore = { read: async ref => records[ref] };
  const verify = (draft = state, snapshot = final) => verifyBlockedDraftArtifacts({ drafts: [draft], snapshot,
    artifactRoot: 'docs/amend', evidenceStore });
  assert.deepEqual([...await verify()].sort(), ['docs/amend/candidate.json', 'docs/amend/fix.json']);
  const changed = structuredClone(final); changed.files[1].sha256 = 'tampered'; changed.digest = digestJson(changed.files);
  await assert.rejects(verify(state, changed), { code: 'PLAN_AMENDMENT_DRAFT_ARTIFACT_CHANGED' });
  const extra = structuredClone(final); extra.files.push({ path: 'docs/amend/unclaimed', sha256: 'x', size: 1 });
  assert.equal((await verify(state, extra)).has('docs/amend/unclaimed'), false);
  records.e1.bytes = Buffer.from('{}');
  await assert.rejects(verify(), { code: 'PLAN_AMENDMENT_DRAFT_ARTIFACT_INVALID' });
  assert.equal(state.attempts.progress.used, 21);
  assert.equal(state.submissions[2].submissionDigest,
    digestJson(withoutKeys(state.submissions[2], ['submissionDigest'])));
});
