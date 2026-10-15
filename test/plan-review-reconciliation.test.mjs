import test from 'node:test';
import assert from 'node:assert/strict';
import { digestJson } from '../src/common/canonical.mjs';
import { planReviewResolutionCandidates, verifyPlanReviewResolutionEvidence } from '../src/application/plan-review-reconciliation.mjs';

const checkpoint = id => ({ id, status: 'resolved', summary: `${id} has a verified correction.`, evidence: ['docs/contract.md'] });
export const reviewLedger = () => {
  const features = ['one', 'two', 'three'].map((id, index, ids) => ({ id, state: 'completed',
    metadata: { stage: 'plan-review', sourcePolicy: 'read-only' }, allowedPaths: [],
    dependsOn: index ? [ids[index - 1]] : [] }));
  const finding = { id: 'PR-1', severity: 'P1', summary: 'Old path remains an execution input.' };
  const values = [
    { approved: false, findings: ['PR-1 [P1] old path'] },
    { approved: false, findings: ['PR-2 [P1] producer order'], previousFindings: { 'PR-1': 'The old path is now historical evidence; producer ordering needs PR-2.' } },
    { approved: true, findings: [], resolvedFindings: ['PR-2'] },
  ];
  const submissions = values.map((value, index) => {
    const body = { submissionId: `s${index}`, featureId: features[index].id, dispatchId: `d${index}`,
      epoch: 1, generation: 1, inputSourceDigest: 'source', outputSourceDigest: 'source',
      evidenceRefs: [`ref${index}`], result: { status: 'completed', changedFiles: [],
        findings: index === 0 ? [finding] : [], checkpoints: index === 2 ? [checkpoint('PR-2')] : [],
        outputs: { 'plan-review': { value } } } };
    return { ...body, submissionDigest: digestJson(body) };
  });
  const state = { projectId: 'project', runId: 'run', features, submissions,
    findings: [{ ...finding, source: 'review', status: 'open', featureId: 'one', evidenceRefs: ['ref0'] }] };
  const assessment = { id: 'PR-1', reviewSubmissionId: 's1',
    quotedAssessment: values[1].previousFindings['PR-1'], supersededBy: ['PR-2'],
    summary: 'The committed second review verifies the old-path correction; its producer blocker is explicitly resolved by the final review.' };
  return { state, assessment };
};

test('clean approval cannot clear old findings; exact legacy evidence chain can', () => {
  const { state, assessment } = reviewLedger();
  assert.deepEqual(planReviewResolutionCandidates(state), []);
  const [candidate] = planReviewResolutionCandidates(state, [assessment]);
  assert.equal(candidate.id, 'PR-1');
  assert.deepEqual(candidate.evidenceRefs, ['ref0', 'ref1', 'ref2']);
  assert.equal(candidate.resolution.operatorAssessment.quotedAssessment, assessment.quotedAssessment);
  for (const change of [
    (s, a) => { a.quotedAssessment = 'different'; },
    (s, a) => { a.supersededBy = []; },
    s => { s.features[2].dependsOn = []; },
    s => { s.submissions[2].result.outputs['plan-review'].value.resolvedFindings = []; },
    s => { s.submissions[2].result.checkpoints = []; },
    s => { s.submissions[2].result.outputs['plan-review'].value.approved = false; },
    s => { s.submissions[2].result.findings = [{ id: 'PR-1' }]; },
    s => { s.features[1].allowedPaths = ['src']; },
  ]) {
    const copy = reviewLedger();
    change(copy.state, copy.assessment);
    assert.throws(() => planReviewResolutionCandidates(copy.state, [copy.assessment]),
      { code: 'PLAN_REVIEW_RECONCILIATION_INVALID' });
  }
});

test('explicit per-finding checkpoints resolve earlier issues even when the next review rejects new issues', () => {
  const { state } = reviewLedger();
  const second = state.submissions[1];
  second.result.outputs['plan-review'].value.resolvedFindings = ['PR-1'];
  second.result.checkpoints.push(checkpoint('PR-1'));
  assert.equal(planReviewResolutionCandidates(state)[0].resolution.reviewSubmissionId, 's1');
  state.submissions[2].result.outputs['plan-review'].value.findings.push('PR-1 [P1] regressed');
  assert.deepEqual(planReviewResolutionCandidates(state), []);
});

test('resolution verifies every sealed result digest and Evidence context before any mutation', async () => {
  const { state, assessment } = reviewLedger();
  const candidates = planReviewResolutionCandidates(state, [assessment]);
  const read = async ref => {
    const submission = state.submissions.find(item => item.evidenceRefs.includes(ref));
    return { metadata: { projectId: state.projectId, runId: state.runId, featureId: submission.featureId,
      dispatchId: submission.dispatchId, epoch: 1, generation: 1 },
    bytes: Buffer.from(JSON.stringify({ result: submission.result,
      inputSourceDigest: submission.inputSourceDigest, outputSourceDigest: submission.outputSourceDigest })) };
  };
  await verifyPlanReviewResolutionEvidence(state, candidates, { read });
  await assert.rejects(verifyPlanReviewResolutionEvidence(state, candidates, { read: async ref => {
    const record = await read(ref); record.metadata.runId = 'different'; return record;
  } }), { code: 'PLAN_REVIEW_EVIDENCE_MISMATCH' });
  state.submissions[1].result.summary = 'tampered';
  await assert.rejects(verifyPlanReviewResolutionEvidence(state, candidates, { read }), { code: 'PLAN_REVIEW_EVIDENCE_MISMATCH' });
});
