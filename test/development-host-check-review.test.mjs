import assert from 'node:assert/strict';
import test from 'node:test';
import { digestJson } from '../src/common/canonical.mjs';
import { featureContractDigest } from '../src/common/interruption-contract.mjs';
import { inspectDevelopmentHostCheckReview, selectDevelopmentHostCheck } from '../src/application/development-host-check-review.mjs';
import { selectBlockedResumeFeature } from '../src/application/lifecycle-resume.mjs';

const fixture = () => {
  const check = { executionClass: 'deterministic-process', cacheable: false,
    command: ['node', 'check.mjs'], inputs: ['check.mjs'], outputs: ['tmp/proof.json'] };
  const blocker = { kind: 'permission', code: 'host-failed' };
  const feature = { id: 'a', logicalRoot: 'implement:a', state: 'blocked', blocker,
    allowedPaths: ['check.mjs'], forbiddenPaths: [], acceptance: [],
    metadata: { stage: 'implementation', deliveryBatch: { checks: [check] }, verificationOutputPaths: ['tmp'] } };
  const result = { status: 'blocked', failureClass: 'external-prerequisite', blocker,
    deliveryPrerequisites: [{ classification: 'delivery-prerequisite', affectedPaths: ['check.mjs'] }] };
  const body = { featureId: feature.id, dispatchId: 'dispatch', evidenceRefs: ['submission-evidence'], outputSourceDigest: 'source', result };
  const submission = { ...body, submissionDigest: digestJson(body) };
  const state = { runId: 'old', projectId: 'project', sourceDigest: 'source', revision: 1,
    features: [feature], submissions: [submission], leases: [], dispatches: [], decisions: [],
    attempts: { 'implement:a:external-prerequisite': { failures: 2, limit: 3, exhausted: false, logicalRoot: 'implement:a' } },
    metadata: { commandIntent: { action: 'implement' } } };
  const carryover = { firstPendingFeatureId: feature.id, priorAuthorityDigest: 'before', carryoverDigest: 'carry', replacementRunId: 'new' };
  const review = { kind: 'delivery-host-check-review', actor: 'operator', projectId: state.projectId, runId: state.runId,
    featureId: feature.id, expectedRevision: state.revision, sourceDigest: state.sourceDigest,
    submissionDigest: submission.submissionDigest, contractDigest: featureContractDigest(feature),
    blockerDigest: digestJson(blocker), checkDigest: digestJson(check) };
  return { check, feature, submission, state, carryover, review, currentSourceDigest: state.sourceDigest };
};

test('Host recovery selects only the exact approved check and preserves unrelated approval and budget blockers', () => {
  const f = fixture();
  assert.equal(selectDevelopmentHostCheck(f).check, f.check);
  for (const change of [
    x => { x.review.checkDigest = 'other'; },
    x => { x.review.command = ['other']; },
    x => { x.state.leases.push({ status: 'active' }); },
    x => { x.state.decisions.push({ action: 'freeze-execution', decision: 'approved' }); },
    x => { x.state.attempts['implement:a:external-prerequisite'].exhausted = true; },
    x => { x.currentSourceDigest = 'other'; },
  ]) {
    const input = structuredClone(f);
    change(input);
    assert.throws(() => selectDevelopmentHostCheck(input), { code: 'DEVELOPMENT_HOST_CHECK_REVIEW_INVALID' });
  }
});

test('a sealed fresh Host receipt reopens only the matching transferred Submission', async () => {
  const f = fixture();
  const resolution = { ...f.review, kind: 'delivery-host-check-resolution', priorAuthorityDigest: 'before',
    carryoverDigest: 'carry', replacementRunId: 'new', evidenceRef: 'fresh' };
  const prior = { ...f.state, status: 'superseded', authorityDigest: 'after', metadata: {
    supersededByRunId: 'new', completionCarryover: { plan: f.carryover, environmentReview: resolution } } };
  const state = { ...f.state, runId: 'new', metadata: { completionCarryover: {
    priorRunId: 'old', priorAuthorityDigest: 'after', carryoverDigest: 'carry', progressOnly: true } } };
  const receipt = { kind: 'delivery-verification-receipt', approvedCheck: f.check, status: 'passed',
    cacheHit: false, sourceDrift: false, sourceBefore: 'source', sourceAfter: 'source' };
  const authorityStore = { read: async () => prior };
  const evidenceStore = { read: async () => ({ metadata: { projectId: 'project', runId: 'old',
    featureId: 'a', dispatchId: 'dispatch', sourceDigest: 'source' }, bytes: Buffer.from(JSON.stringify(receipt)) }) };
  assert.throws(() => selectBlockedResumeFeature(state), { code: 'LIFECYCLE_RESUME_BLOCKER_REQUIRES_REVIEW' });
  const hostCheckReviews = await inspectDevelopmentHostCheckReview(state, authorityStore, evidenceStore);
  assert.equal(selectBlockedResumeFeature(state, { hostCheckReviews }), f.feature.id);
  assert.deepEqual(await inspectDevelopmentHostCheckReview({ ...state, sourceDigest: 'changed' }, authorityStore, evidenceStore), []);
  receipt.cacheHit = true;
  await assert.rejects(() => inspectDevelopmentHostCheckReview(state, authorityStore, evidenceStore),
    { code: 'DEVELOPMENT_HOST_CHECK_REVIEW_INVALID' });
});
