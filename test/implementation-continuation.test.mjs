import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sha256, digestJson } from '../src/common/canonical.mjs';
import { buildImplementationContinuation, hasNewAcceptanceCheckpoint } from '../src/application/implementation-continuation.mjs';
import { selectBlockedResumeFeature } from '../src/application/lifecycle-resume.mjs';
import { shouldContinueImplementationProgress } from '../src/application/lifecycle-execution-service.mjs';
import { command, feature as makeFeature, makeFixture, startRun } from './test-support.mjs';

const incomplete = { status: 'blocked', failureClass: 'implementation-incomplete', summary: 'Owner implementation unfinished.',
  blocker: { kind: 'implementation', summary: 'Complete the aggregate and retire its source.', resumeWhen: 'Implement the final receiver.' } };
const feature = { id: 'implement/package', logicalRoot: 'root/package', state: 'blocked', metadata: { stage: 'implementation',
  implementationProgressRetries: 20, approvedProposal: { id: 'package', contracts: ['plan.json#/proposedFeatures/0/contracts'],
    verification: [{ specificationRef: 'plan.json#/proposedFeatures/0/verification/0' }] } } };
const last = { submissionId: 's32', featureId: feature.id, result: incomplete, inputSourceDigest: 'source',
  outputSourceDigest: 'source', changedFiles: [], evidenceRefs: ['evidence:prior'], attemptBudgetKey: 'root/package:implementation-incomplete' };
const state = () => ({ sourceDigest: 'source', features: [structuredClone(feature)], submissions: [structuredClone(last)], dispatches: [],
  attempts: { 'root/package:implementation-incomplete': { failures: 32, limit: 41, exhausted: false } } });

const fixture = async t => {
  const f = await makeFixture(); t.after(f.cleanup);
  const workspace = resolve(f.root, 'continuation-workspace'); await mkdir(workspace, { recursive: true });
  const plan = { proposedFeatures: [{ contracts: ['Complete the final receiver.'], verification: [{ id: 'verify-owner', commands: ['verify-owner'] }] }],
    sourceLifecycleContract: { sources: [{ sourcePath: 'old/source', lastExitFeature: 'package', finalPaths: ['new/receiver'] },
      { sourcePath: 'future/source', lastExitFeature: 'future', finalPaths: ['future/receiver'] }] } };
  const inventory = { mixedAggregateContract: { aggregates: [{ source_symbol: 'Aggregate', complete_source_members: ['member'],
    member_conversions: [{ target_path: 'new/receiver' }] }], certificateProductionContract: { aggregateCertificates: [
    { sourceSymbol: 'Aggregate', capabilityProducer: 'package', sourceSha256: 'a'.repeat(64), memberCount: 1,
      requiredAssertions: ['bounds', 'inverse', 'native-wasm', 'zero-commit', 'replay-continuation'], nativeDependencies: [] },
    { sourceSymbol: 'Future', capabilityProducer: 'future' }] } } };
  const pin = async (path, value) => { const bytes = JSON.stringify(value); await writeFile(resolve(workspace, path), bytes); return { path, sha256: sha256(bytes) }; };
  const s = state(); s.features[0].metadata.approvedDeliveryPlan = {
    expandedPlan: await pin('plan.json', plan), sourceInventory: await pin('inventory.json', inventory) };
  return { s, workspace };
};

test('explicit implementation reentry accepts an unchanged latest submission without resetting history or budget', () => {
  const s = state(); s.features.unshift({ id: 'done', state: 'completed' });
  const before = digestJson(s);
  assert.equal(selectBlockedResumeFeature(s), feature.id);
  assert.equal(digestJson(s), before);
  for (const kind of ['approval', 'external', 'permission-denied', 'scope-blocker']) {
    const denied = state(); denied.submissions[0].result.blocker.kind = kind;
    assert.throws(() => selectBlockedResumeFeature(denied), { code: 'LIFECYCLE_RESUME_BLOCKER_REQUIRES_REVIEW' });
  }
  const exhausted = state(); exhausted.attempts[last.attemptBudgetKey].exhausted = true;
  assert.throws(() => selectBlockedResumeFeature(exhausted), { code: 'LIFECYCLE_RESUME_BUDGET_EXHAUSTED' });
});

test('continuation resolves exact pinned contracts, checks, aggregate members and last-owner source exits', async t => {
  const { s, workspace } = await fixture(t); const before = digestJson(s);
  const context = await buildImplementationContinuation(s, s.features[0], workspace);
  assert.deepEqual(context.obligations.map(item => item.kind), ['contract', 'verification', 'aggregate-certificate', 'source-exit']);
  assert.equal(context.obligations[0].description, 'Complete the final receiver.');
  assert.deepEqual(context.verification[0].commands, ['verify-owner']);
  assert.deepEqual(context.obligations[2].members, ['member']);
  assert.equal(context.obligations[3].key, 'old/source');
  assert.equal(context.history[0].blocker.resumeWhen, 'Implement the final receiver.');
  assert.deepEqual(context.budget, { used: 32, limit: 41, exhausted: false });
  assert.equal(digestJson(s), before);
  assert.deepEqual(await buildImplementationContinuation(s, s.features[0], workspace), context);
  await writeFile(resolve(workspace, 'plan.json'), '{}');
  await assert.rejects(buildImplementationContinuation(s, s.features[0], workspace), { code: 'IMPLEMENTATION_CONTINUATION_INPUT_STALE' });
});

test('continuation never follows unpinned or escaping plan references', async t => {
  const { s, workspace } = await fixture(t);
  s.features[0].metadata.approvedProposal.verification[0].specificationRef = 'other.json#/checks/0';
  await assert.rejects(buildImplementationContinuation(s, s.features[0], workspace), { code: 'IMPLEMENTATION_CONTINUATION_REFERENCE_INVALID' });
  s.features[0].metadata.approvedDeliveryPlan.expandedPlan.path = '../outside.json';
  await assert.rejects(buildImplementationContinuation(s, s.features[0], workspace), { code: 'PATH_OUTSIDE_ROOT' });
});

test('automatic continuation requires a new approved checkpoint, not source churn or repeated green checks', async t => {
  const { s, workspace } = await fixture(t); const f = s.features[0];
  const context = await buildImplementationContinuation(s, f, workspace);
  const submission = { ...last, submissionId: 's33', dispatchId: 'dispatch', inputSourceDigest: 'source', outputSourceDigest: 'next',
    changedFiles: ['new/tests'], evidenceRefs: ['evidence:fresh'], result: { ...incomplete, checkpoints: [
      { id: 'runtime-already-passed', status: 'completed', summary: '31 checks pass.', evidence: ['log'] }] } };
  s.dispatches.push({ dispatchId: 'dispatch', execution: { implementationContinuation: context } });
  s.submissions.push(submission);
  const continueNow = () => shouldContinueImplementationProgress({ feature: f, result: submission.result, state: s, submission });
  assert.equal(continueNow(), false);
  submission.result.checkpoints[0].id = context.obligations[2].id;
  assert.equal(continueNow(), true);
  submission.changedFiles = []; submission.outputSourceDigest = 'source';
  assert.equal(continueNow(), true); // Real acceptance evidence can advance without a source edit.
  submission.result.checkpoints[0].evidence = [];
  assert.equal(continueNow(), false);
  submission.result.checkpoints[0].evidence = ['log']; submission.evidenceRefs = [];
  assert.equal(continueNow(), false);
  submission.evidenceRefs = ['evidence:fresh'];
  s.submissions[0].result = structuredClone(submission.result);
  assert.equal(hasNewAcceptanceCheckpoint(s, f, submission, context), false);
  assert.equal(continueNow(), false);
  s.submissions[0].result = incomplete;
  s.attempts[last.attemptBudgetKey].exhausted = true;
  assert.equal(continueNow(), false);
});

for (const explicit of [true, false]) {
  test(`Dispatch snapshots and recompiles obligation context through ${explicit ? 'explicit' : 'scheduler'} selection`, async t => {
    const f = await makeFixture(); t.after(f.cleanup);
    const proposal = { id: 'owner', projectId: f.projectId, disposition: 'project-owned', contracts: ['Close owner.'], verification: ['Check owner.'] };
    const item = makeFeature('one', { stage: 'implementation', approvedProposal: proposal,
      approvedDeliveryPlan: { proposedFeatures: [proposal] } });
    let s = await startRun(f, { features: [item] });
    const scheduled = await f.harness.dispatch(f.projectId, s.runId, { runtimePluginId: 'test-runtime',
      ...(explicit ? { candidateFeatureIds: ['one'] } : {}) }, command(s));
    const dispatch = scheduled.result.dispatches[0];
    const context = dispatch.execution.implementationContinuation;
    assert.equal(context.obligations.length, 2);
    assert.equal(context.proposalId, 'owner');
    assert.match(context.instructions.join('\n'), /execution unit is this complete Feature/);
    assert.match(context.instructions.join('\n'), /Do not voluntarily return after one local fix/);
    assert.match(context.instructions.join('\n'), /run every mandatory final check/);
    const stored = await f.harness.readDispatchPacket(f.projectId, s.runId, dispatch.dispatchId);
    assert.deepEqual(stored.packet.execution.implementationContinuation, context);
    assert.equal(stored.prompt.packetDigest, dispatch.packetDigest);
  });
}

test('coarser execution preserves all obligations, protected handoffs, acceptance evidence and existing accounting', async t => {
  const { s, workspace } = await fixture(t);
  const before = digestJson(s);
  const context = await buildImplementationContinuation(s, s.features[0], workspace);
  const instructions = context.instructions.join('\n');
  assert.equal(context.obligations.length, 4);
  assert.deepEqual(context.budget, { used: 32, limit: 41, exhausted: false });
  assert.match(instructions, /batch creates no new Feature, Lease, authority or budget/);
  assert.match(instructions, /a recovery fallback, not a planned stopping point/);
  assert.match(instructions, /actual host\/runtime\/context limit that prevents further execution/);
  assert.match(instructions, /Name the exact stopping constraint and its observed evidence/);
  assert.match(instructions, /never reuse stale results or reduce required coverage/);
  assert.equal(digestJson(s), before);
  assert.deepEqual(await buildImplementationContinuation(s, s.features[0], workspace), context);
  const result = { ...last, submissionId: 'no-progress', result: { ...incomplete, checkpoints: [
    { id: 'runtime-already-passed', status: 'completed', evidence: ['fresh-green-suite'] },
  ] } };
  assert.equal(hasNewAcceptanceCheckpoint(s, s.features[0], result, context), false);
});
