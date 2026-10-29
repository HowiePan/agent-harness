import assert from 'node:assert/strict';
import test from 'node:test';
import { buildImplementationWorkBatch } from '../src/application/implementation-work-batch.mjs';

const step = targetPath => ({ id: `step:${targetPath}`, targetPath });
const input = () => ({
  steps: ['owner/a', 'owner/b', 'receiver', 'unrelated'].map(step),
  obligations: [
    { id: 'certificate:a', kind: 'aggregate-certificate', finalPaths: ['owner/a'], nativeDependencies: [{ targetPath: 'owner/b' }] },
    { id: 'exit:a', kind: 'source-exit', finalPaths: ['owner/b', 'receiver'] },
    { id: 'certificate:b', kind: 'aggregate-certificate', finalPaths: ['receiver'] },
    { id: 'unrelated', kind: 'source-exit', finalPaths: ['unrelated'] },
  ],
  next: step('owner/a'), verified: () => false, closedIds: new Set(), history: [],
});

test('connected delivery includes transitive owners, consumers and original obligations in approved order', () => {
  const args = input();
  const before = structuredClone({ steps: args.steps, obligations: args.obligations });
  const batch = buildImplementationWorkBatch(args);
  assert.deepEqual(batch.targetStepIds, ['step:owner/a', 'step:owner/b', 'step:receiver']);
  assert.deepEqual(batch.pendingTargetStepIds, batch.targetStepIds);
  assert.deepEqual(batch.obligationIds, ['certificate:a', 'exit:a', 'certificate:b']);
  assert.deepEqual(batch.unavailableDependencyPaths, []);
  assert.deepEqual({ steps: args.steps, obligations: args.obligations }, before);
  assert.deepEqual(buildImplementationWorkBatch(args), batch);
});

test('certificate frontier requires every referenced target, never grants missing or forbidden dependency scope', () => {
  const args = input();
  args.verified = item => item.targetPath === 'owner/a';
  assert.deepEqual(buildImplementationWorkBatch(args).certificateCandidateIds, []);
  args.verified = () => true;
  args.obligations[0].nativeDependencies.push({ targetPath: 'outside/owner' });
  const batch = buildImplementationWorkBatch(args);
  assert.deepEqual(batch.certificateCandidateIds, ['certificate:b']);
  assert.deepEqual(batch.unavailableDependencyPaths, ['outside/owner']);
  assert.equal(batch.targetStepIds.includes('step:outside/owner'), false);
  assert.equal(batch.acceptanceStatus, 'unverified-candidates-only');
});

test('existing receivers remain certificate candidates after all development targets have checkpoints', () => {
  const args = input(); args.next = null; args.verified = () => true;
  const batch = buildImplementationWorkBatch(args);
  assert.deepEqual(batch.certificateCandidateIds, ['certificate:a', 'certificate:b']);
  assert.deepEqual(batch.pendingTargetStepIds, []);
  assert.deepEqual(batch.obligationIds, ['certificate:a', 'exit:a', 'certificate:b']);
  args.closedIds.add('certificate:a'); args.closedIds.add('certificate:b');
  assert.deepEqual(buildImplementationWorkBatch(args).certificateCandidateIds, []);
});

test('approved supporting evidence paths are distinguished from out-of-scope owner dependencies', () => {
  const args = input();
  args.obligations[1].finalPaths.push('tests/declarations.json', 'external/owner');
  args.isAllowedPath = path => args.steps.some(step => step.targetPath === path) || path === 'tests/declarations.json';
  const batch = buildImplementationWorkBatch(args);
  assert.deepEqual(batch.supportingPaths, ['tests/declarations.json']);
  assert.deepEqual(batch.unavailableDependencyPaths, ['external/owner']);
  assert.equal(batch.targetStepIds.includes('step:tests/declarations.json'), false);
});

test('development-only handoffs are visible and green suite labels do not count as acceptance', () => {
  const args = input();
  const done = id => ({ id, status: 'completed', evidence: ['proof'] });
  const blocked = checkpoints => ({ result: { status: 'blocked', checkpoints } });
  args.history = [blocked([done('certificate:a')]), blocked([done('green-suite')]), blocked([done('step:owner/a')])];
  assert.equal(buildImplementationWorkBatch(args).consecutiveDevelopmentHandoffs, 2);
  args.history.push(blocked([done('certificate:b')]));
  assert.equal(buildImplementationWorkBatch(args).consecutiveDevelopmentHandoffs, 0);
});
