import assert from 'node:assert/strict';
import test from 'node:test';
import { HarnessKernel } from '../src/kernel/kernel.mjs';
import { qualityRepairScopeCandidates } from '../src/kernel/quality.mjs';
import { validateBusinessResult } from '../src/platform/execution/result-contract.mjs';
import { deriveQualityTargetSnapshot } from '../src/platform/execution/quality-target.mjs';

const repair = () => ({
  id: 'repair-1', logicalRoot: 'finding:Q1', state: 'blocked', allowedPaths: ['engine/src/bug.rs'],
  forbiddenPaths: ['external', '.git'], metadata: {
    stage: 'quality-repair', repairFindingId: 'Q1', repairFindings: [{ id: 'Q1', affectedPaths: ['engine/src/bug.rs'] }],
    qualityContext: { repairScopePaths: ['engine'], verificationOutputPaths: ['engine/target'] },
  },
});
const blocked = paths => ({ status: 'blocked', failureClass: 'scope-blocker',
  blocker: { kind: 'scope', summary: 'The focused test also needs an update.', repairCandidatePaths: paths } });

test('quality scope continuation records the exact blocker source and reopens the same repair', async () => {
  const feature = repair();
  const submission = { submissionId: 's1', featureId: feature.id, result: blocked(['engine/tests/bug_test.rs']) };
  const state = { status: 'all-remaining-blocked', profile: { id: 'fixture' }, features: [feature], submissions: [submission],
    leases: [], dispatches: [], findings: [], events: [] };
  const authorityStore = { async transact(_projectId, _runId, _command, mutate) {
    const result = mutate(state);
    return { result, state };
  } };
  const kernel = new HarnessKernel({ authorityStore, profiles: new Map([['fixture', { canClose: () => ({ ok: true }) }]]) });
  assert.deepEqual(qualityRepairScopeCandidates(feature, submission.result.blocker), ['engine/tests/bug_test.rs']);
  await kernel.reopenFeature('project', 'run', { featureId: feature.id,
    additionalAllowedPaths: ['engine/tests/bug_test.rs'], reason: 'Continue the repair.' }, { expectedRevision: 1, commandId: 'extend-scope' });
  assert.equal(feature.state, 'pending');
  assert.deepEqual(feature.allowedPaths, ['engine/src/bug.rs', 'engine/tests/bug_test.rs']);
  assert.deepEqual(feature.metadata.scopeExtensions[0].submissionId, 's1');
  assert.equal(state.events.some(event => event.type === 'feature.quality-scope-extended' && event.submissionId === 's1'), true);
});

test('quality scope continuation refuses unrelated, unsafe, and unstructured paths', () => {
  const feature = repair();
  for (const path of ['external/lock.json', '../engine/tests/bug_test.rs', 'C:/temp/x', 'engine/target/output.json', 'docs/release.md']) {
    assert.deepEqual(qualityRepairScopeCandidates(feature, blocked([path]).blocker), []);
  }
  assert.deepEqual(qualityRepairScopeCandidates(feature, { kind: 'scope', summary: 'repairCandidatePaths: ["engine/tests/bug_test.rs"]' }), []);
});

test('quality result and historical target separate delivery prerequisites from source findings', () => {
  const code = { id: 'Q1', severity: 'P1', summary: 'Current code defect', evidence: ['engine/src/bug.rs:3'], affectedPaths: ['engine/src/bug.rs'] };
  const gate = { id: 'G08', severity: 'P1', summary: 'Release documentation is pending', evidence: ['release gate pending'], affectedPaths: ['docs/release.md'] };
  const feature = { metadata: { qualityReview: true, qualityContext: { findingScopePaths: ['engine'] } } };
  const result = validateBusinessResult({ status: 'completed', summary: 'Review complete', changedFiles: [], findings: [code, gate] }, { feature });
  assert.deepEqual(result.findings.map(item => item.id), ['Q1']);
  assert.deepEqual(result.deliveryPrerequisites.map(item => item.id), ['G08']);
  assert.throws(() => validateBusinessResult({ status: 'completed', summary: 'Invalid classification', changedFiles: [], findings: [],
    deliveryPrerequisites: [{ id: 'Q1', summary: 'Code defect', evidence: ['engine/src/bug.rs:3'], affectedPaths: ['engine/src/bug.rs'],
      classification: 'delivery-prerequisite', reason: 'manual' }] }, { feature }), error => error.code === 'QUALITY_PREREQUISITE_INVALID');
  const run = { projectId: 'project', runId: 'prior', revision: 1, status: 'incomplete', sourceDigest: 'a'.repeat(64), authorityDigest: 'b'.repeat(64),
    metadata: { commandIntent: { target: 'V1', workflowId: 'workflow' } }, findings: [code, gate] };
  const target = deriveQualityTargetSnapshot({ projectId: 'project', workflowId: 'workflow', target: 'V1', sourceDigest: 'a'.repeat(64),
    runs: [run], findingScopePaths: ['engine'] });
  assert.deepEqual(target.findings.map(item => item.id), ['Q1']);
  assert.deepEqual(target.prerequisites.map(item => item.id), ['G08']);
  const submissionTarget = deriveQualityTargetSnapshot({ projectId: 'project', workflowId: 'workflow', target: 'V1', sourceDigest: 'a'.repeat(64),
    runs: [{ ...run, findings: [], submissions: [{ submissionId: 's2', result, evidenceRefs: ['evidence:review'],
      outputSourceDigest: 'a'.repeat(64) }] }], findingScopePaths: ['engine'] });
  assert.deepEqual(submissionTarget.prerequisites.map(item => item.id), ['G08']);
  assert.deepEqual(submissionTarget.prerequisites[0].evidenceRefs, ['evidence:review']);
});
