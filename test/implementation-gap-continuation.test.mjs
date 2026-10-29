import assert from 'node:assert/strict';
import test from 'node:test';
import { selectBlockedResumeFeature } from '../src/application/lifecycle-resume.mjs';
import { HANDOFF_CORRECTION_POLICY, shouldCorrectImplementationHandoff,
  implementationHandoffCorrectionReason } from '../src/application/implementation-handoff.mjs';
import { classifyFragmentedDeliveryHandoff, deliveryBatchFeedback } from '../src/flows/delivery-lifecycle/delivery-feedback.mjs';
import { compile } from './delivery-batch-support.mjs';

const fixture = (status = 'failed', failureClass = 'implementation-gap', kind = 'implementation-gap') => {
  const [feature] = compile(); feature.state = 'blocked';
  const submission = { submissionId: 'partial', dispatchId: 'dispatch', featureId: feature.id,
    attemptBudgetKey: `${feature.logicalRoot}:${failureClass}`, evidenceRefs: ['evidence:partial'],
    inputSourceDigest: 'before', outputSourceDigest: 'after', changedFiles: ['src/receiver.mjs'],
    result: { status, failureClass, summary: 'Assigned behavior remains unfinished.', blocker: { kind } } };
  const context = { correctionPolicy: { id: HANDOFF_CORRECTION_POLICY }, workBatch: feature.metadata.deliveryBatch };
  const state = { features: [feature], submissions: [submission], events: [],
    dispatches: [{ dispatchId: 'dispatch', execution: { implementationContinuation: context } }],
    attempts: { [submission.attemptBudgetKey]: { failures: 1, limit: 3, exhausted: false } } };
  return { state, feature, submission, context, commandId: 'invocation' };
};

for (const status of ['failed', 'blocked']) {
  for (const failureClass of ['implementation-incomplete', 'implementation-gap']) {
    for (const kind of ['implementation', 'implementation-gap']) {
      test(`${status}/${failureClass}/${kind} resumes with the original charged ledger and one bounded correction`, () => {
        const f = fixture(status, failureClass, kind); const before = structuredClone(f.state);
        assert.equal(selectBlockedResumeFeature(f.state), f.feature.id);
        assert.equal(shouldCorrectImplementationHandoff(f), true);
        assert.deepEqual(f.state, before);
        f.state.events.push({ type: 'feature.reopened', featureId: f.feature.id,
          reason: implementationHandoffCorrectionReason(f.commandId, f.feature, f.context) });
        assert.equal(shouldCorrectImplementationHandoff(f), false);
        f.state.attempts[f.submission.attemptBudgetKey].exhausted = true;
        assert.equal(shouldCorrectImplementationHandoff({ ...f, commandId: 'new-invocation' }), false);
        assert.throws(() => selectBlockedResumeFeature(f.state), { code: 'LIFECYCLE_RESUME_BUDGET_EXHAUSTED' });
      });
    }
  }
}

test('a gap label grants neither scope, external, environment nor capacity authority; evidence remains mandatory', () => {
  for (const kind of ['scope', 'external', 'environment', 'approval', 'context-limit', 'delivery-sizing-review']) {
    const f = fixture('failed', 'implementation-gap', kind);
    assert.equal(shouldCorrectImplementationHandoff(f), false);
    assert.throws(() => selectBlockedResumeFeature(f.state), { code: 'LIFECYCLE_RESUME_BLOCKER_REQUIRES_REVIEW' });
  }
  const f = fixture(); f.submission.evidenceRefs = [];
  assert.equal(shouldCorrectImplementationHandoff(f), false);
  assert.throws(() => selectBlockedResumeFeature(f.state), { code: 'LIFECYCLE_RESUME_BLOCKER_REQUIRES_REVIEW' });
  f.submission.evidenceRefs = ['evidence:partial']; f.submission.result.failureClass = 'unknown-gap-label';
  assert.equal(shouldCorrectImplementationHandoff(f), false);
});

test('mixed failed/blocked gap spellings count toward the same batch sizing review without rewriting native history', () => {
  const f = fixture(); const second = structuredClone(f.submission);
  second.submissionId = 'partial-2'; second.result.status = 'blocked';
  second.result.failureClass = 'implementation-incomplete';
  f.state.submissions.push(second);
  const before = structuredClone(f.state);
  const feedback = deliveryBatchFeedback(f.state, f.feature);
  assert.equal(feedback.unplannedHandoffs, 2); assert.equal(feedback.sizingReviewSuggested, true);
  const result = classifyFragmentedDeliveryHandoff(f.state, f.feature, f.submission.result);
  assert.equal(result.failureClass, 'implementation-sizing-review');
  assert.equal(result.blocker.kind, 'delivery-sizing-review');
  assert.deepEqual(f.state, before);
  for (const kind of ['scope', 'external', 'environment']) {
    const held = { ...f.submission.result, blocker: { kind } };
    assert.equal(classifyFragmentedDeliveryHandoff(f.state, f.feature, held), held);
  }
  const observed = { ...f.submission.result, observations: ['Host verification evidence: sealed-check'] };
  assert.equal(classifyFragmentedDeliveryHandoff(f.state, f.feature, observed), observed);
  f.state.dispatches = [];
  assert.equal(deliveryBatchFeedback(f.state, f.feature).unplannedHandoffs, 0);
});
