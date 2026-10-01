import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldContinueImplementationProgress, shouldRetryImplementationVerificationPath } from '../src/application/lifecycle-execution-service.mjs';

const feature = {
  id: 'implement/V-next', logicalRoot: 'implement:V-next',
  allowedPaths: ['scripts'], forbiddenPaths: ['tabletop-collection'],
  metadata: { stage: 'implementation', verificationRepairRetries: 2 },
};
const result = {
  status: 'blocked', failureClass: 'verification-path-prohibited',
  blocker: { kind: 'verification-path-prohibited', summary: 'Check writes outside the declared output path.', repairCandidatePaths: ['scripts/cardworld.ps1'] },
};
const state = failures => ({
  features: [{ ...feature, state: failures >= 3 ? 'failed-budget' : 'blocked' }],
  attempts: { 'implement:V-next:verification-path-prohibited': { failures, limit: 3, exhausted: failures >= 3 } },
});

test('implementation verification-path blocker retries inside the same bounded Feature', () => {
  assert.equal(shouldRetryImplementationVerificationPath({ feature, result, state: state(1) }), true);
  assert.equal(shouldRetryImplementationVerificationPath({ feature, result, state: state(2) }), true);
  assert.equal(shouldRetryImplementationVerificationPath({ feature, result, state: state(3) }), false);
});

test('verification recovery never retries unrelated failures or non-implementation work', () => {
  assert.equal(shouldRetryImplementationVerificationPath({ feature, result: { ...result, failureClass: 'permission-denied' }, state: state(1) }), false);
  assert.equal(shouldRetryImplementationVerificationPath({ feature, result: { ...result, status: 'failed' }, state: state(1) }), false);
  assert.equal(shouldRetryImplementationVerificationPath({ feature: { ...feature, metadata: { ...feature.metadata, stage: 'quality' } }, result, state: state(1) }), false);
  assert.equal(shouldRetryImplementationVerificationPath({ feature: { ...feature, metadata: { ...feature.metadata, verificationRepairRetries: 0 } }, result, state: state(1) }), false);
});

test('verification recovery stops when no authorized source repair is identified', () => {
  assert.equal(shouldRetryImplementationVerificationPath({ feature, result: { ...result, blocker: { kind: 'verification-path-prohibited', summary: 'Collection writes forbidden outputs.' } }, state: state(1) }), false);
  for (const path of ['tabletop-collection/.cargo/config.toml', '../scripts/cardworld.ps1', 'C:/temp/output']) {
    assert.equal(shouldRetryImplementationVerificationPath({ feature, result: { ...result, blocker: { ...result.blocker, repairCandidatePaths: [path] } }, state: state(1) }), false);
  }
});

test('incomplete implementation continues for novel source progress within the expanded round budget', () => {
  const progressive = { ...feature, metadata: { ...feature.metadata, implementationProgressRetries: 20 } };
  const partial = { status: 'blocked', failureClass: 'implementation-incomplete' };
  const submission = { submissionId: 's3', featureId: progressive.id, inputSourceDigest: 'before', outputSourceDigest: 'after', changedFiles: ['scripts/cardworld.ps1'], result: partial };
  const active = { features: [{ ...progressive, state: 'blocked' }], submissions: [submission],
    attempts: { 'implement:V-next:implementation-incomplete': { failures: 1, limit: 3, exhausted: false } } };
  assert.equal(shouldContinueImplementationProgress({ feature: progressive, result: partial, state: active, submission }), true);
  const legacy = { ...partial, failureClass: 'external-prerequisite-and-incomplete-implementation' };
  assert.equal(shouldContinueImplementationProgress({ feature: progressive, result: legacy,
    state: { ...active, submissions: [{ ...submission, result: legacy }],
      attempts: { 'implement:V-next:external-prerequisite-and-incomplete-implementation': { failures: 1, limit: 3, exhausted: false } } }, submission }), true);
  assert.equal(shouldContinueImplementationProgress({ feature: progressive, result: partial, state: active,
    submission: { ...submission, outputSourceDigest: 'before', changedFiles: [] } }), false);
  assert.equal(shouldContinueImplementationProgress({ feature: progressive, result: partial,
    state: { ...active, submissions: [{ ...submission, submissionId: 's1', inputSourceDigest: 'old', outputSourceDigest: 'older' },
      { ...submission, submissionId: 's2', inputSourceDigest: 'older', outputSourceDigest: 'before' }, submission] }, submission }), true);
  assert.equal(shouldContinueImplementationProgress({ feature: { ...progressive, metadata: { ...progressive.metadata, implementationProgressRetries: 2 } }, result: partial,
    state: { ...active, submissions: [{ ...submission, submissionId: 's1', inputSourceDigest: 'old', outputSourceDigest: 'older' },
      { ...submission, submissionId: 's2', inputSourceDigest: 'older', outputSourceDigest: 'before' }, submission] }, submission }), false);
  assert.equal(shouldContinueImplementationProgress({ feature: progressive, result: partial,
    state: { ...active, submissions: [{ ...submission, submissionId: 's2', inputSourceDigest: 'old', outputSourceDigest: 'after' }, submission] }, submission }), false);
  assert.equal(shouldContinueImplementationProgress({ feature: progressive, result: partial, state: { ...active, attempts: { 'implement:V-next:implementation-incomplete': { exhausted: true } } }, submission }), false);
  assert.equal(shouldContinueImplementationProgress({ feature: progressive, result: { ...partial, failureClass: 'permission-denied' }, state: active, submission }), false);
  assert.equal(shouldContinueImplementationProgress({ feature: { ...progressive, metadata: { stage: 'quality' } }, result: partial, state: active, submission }), false);
});

test('implementation continuation rejects source cycles and unrelated blockers', () => {
  const partial = { status: 'blocked', failureClass: 'implementation-incomplete' };
  const current = { submissionId: 'current', featureId: feature.id, inputSourceDigest: 'b', outputSourceDigest: 'a', changedFiles: ['scripts/cardworld.ps1'] };
  const prior = { submissionId: 'prior', featureId: feature.id, inputSourceDigest: 'a', outputSourceDigest: 'b' };
  const progressive = { ...feature, metadata: { ...feature.metadata, implementationProgressRetries: 20 } };
  const state = { features: [{ ...progressive, state: 'blocked' }], submissions: [prior, current],
    attempts: { 'implement:V-next:implementation-incomplete': { failures: 2, limit: 21, exhausted: false } } };
  assert.equal(shouldContinueImplementationProgress({ feature: progressive, result: partial, submission: current, state }), false);
  assert.equal(shouldContinueImplementationProgress({ feature: progressive, result: { ...partial, failureClass: 'permission-denied' }, submission: current, state }), false);
});
