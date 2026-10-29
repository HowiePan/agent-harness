import test from 'node:test';
import assert from 'node:assert/strict';
import { selectBlockedResumeFeature } from '../src/application/lifecycle-resume.mjs';
import { HANDOFF_CORRECTION_POLICY, shouldCorrectImplementationHandoff,
  implementationHandoffCorrectionReason } from '../src/application/implementation-handoff.mjs';

const fixture = () => {
  const feature = { id: 'spatial', logicalRoot: 'implement:owner', state: 'blocked', dependsOn: [],
    metadata: { stage: 'implementation' } };
  const held = { id: 'diagnostics', logicalRoot: 'implement:diagnostics', state: 'blocked', dependsOn: [],
    metadata: { stage: 'implementation' } };
  const submission = { submissionId: 'partial', dispatchId: 'dispatch', featureId: feature.id,
    evidenceRefs: ['evidence:partial'], inputSourceDigest: 'before', outputSourceDigest: 'after',
    result: { status: 'failed', failureClass: 'implementation-incomplete',
      blocker: { kind: 'implementation-gap', summary: 'Five assigned receivers remain.' } } };
  const context = { correctionPolicy: { id: HANDOFF_CORRECTION_POLICY } };
  const state = { features: [feature, held], submissions: [submission,
    { featureId: held.id, result: { status: 'blocked', failureClass: 'scope-blocker', blocker: { kind: 'scope' } } }],
  dispatches: [{ dispatchId: submission.dispatchId, execution: { implementationContinuation: context } }], events: [],
  attempts: { 'implement:owner:implementation-incomplete': { failures: 1, limit: 3, exhausted: false } } };
  return { state, feature, submission, context, commandId: 'invocation' };
};

test('failed implementation-gap gets one corrective retry without relabeling native evidence or spending new allowance', () => {
  const f = fixture(); const before = structuredClone(f.state);
  assert.equal(shouldCorrectImplementationHandoff(f), true);
  assert.deepEqual(f.state, before);
  f.state.events.push({ type: 'feature.reopened', featureId: f.feature.id,
    reason: implementationHandoffCorrectionReason(f.commandId, f.feature, f.context) });
  assert.equal(shouldCorrectImplementationHandoff(f), false);
  f.submission.result.blocker.kind = 'scope';
  assert.equal(shouldCorrectImplementationHandoff({ ...f, commandId: 'another' }), false);
});

test('a separate scope blocker does not hide the executable implementation frontier', () => {
  const f = fixture(); const before = structuredClone(f.state);
  assert.equal(selectBlockedResumeFeature(f.state), 'spatial');
  assert.deepEqual(f.state, before);
  f.feature.dependsOn = ['diagnostics'];
  assert.throws(() => selectBlockedResumeFeature(f.state), { code: 'LIFECYCLE_RESUME_BLOCKER_REQUIRES_REVIEW' });
});

test('multiple eligible frontiers use approved graph order while protected and exhausted work remains held', () => {
  const f = fixture(); const next = { ...structuredClone(f.feature), id: 'another', logicalRoot: 'implement:other' };
  f.state.features.push(next);
  f.state.submissions.push({ ...structuredClone(f.submission), featureId: next.id, submissionId: 'other' });
  f.state.attempts['implement:other:implementation-incomplete'] = { failures: 1, limit: 3, exhausted: false };
  assert.equal(selectBlockedResumeFeature(f.state), 'spatial');
  f.state.attempts['implement:owner:implementation-incomplete'].exhausted = true;
  assert.equal(selectBlockedResumeFeature(f.state), 'another');
  f.state.attempts['implement:other:implementation-incomplete'].exhausted = true;
  assert.throws(() => selectBlockedResumeFeature(f.state), { code: 'LIFECYCLE_RESUME_BLOCKER_REQUIRES_REVIEW' });
});
