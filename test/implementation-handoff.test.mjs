import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256 } from '../src/common/canonical.mjs';
import { digestJson } from '../src/common/canonical.mjs';
import { HANDOFF_CORRECTION_POLICY, correctionReasonPrefix, hasTargetImplementationProgress,
  shouldCorrectImplementationHandoff, implementationHandoffCorrectionReason } from '../src/application/implementation-handoff.mjs';
import { shouldContinueImplementationProgress } from '../src/application/lifecycle-execution-service.mjs';
import { makeFixture, feature as makeFeature, startRun, dispatchAndBind, recordResult, command } from './test-support.mjs';

const fixture = () => {
  const feature = { id: 'owner', logicalRoot: 'implementation/owner', state: 'blocked',
    metadata: { stage: 'implementation', implementationProgressRetries: 40 } };
  const context = { policy: 'approved-obligation-progress/1', correctionPolicy: { id: HANDOFF_CORRECTION_POLICY },
    obligations: [], implementationSteps: [{ id: 'implementation-step:target', targetPath: 'src/target' }],
    nextImplementationStep: { id: 'implementation-step:target', targetPath: 'src/target' } };
  const submission = { submissionId: 's33', featureId: feature.id, dispatchId: 'd33',
    inputSourceDigest: 'source', outputSourceDigest: 'source', changedFiles: [], evidenceRefs: ['evidence:result'],
    attemptBudgetKey: 'implementation/owner:implementation-incomplete',
    result: { status: 'blocked', failureClass: 'implementation-incomplete', summary: 'Certificates missing.',
      blocker: { kind: 'implementation', summary: 'Targets not implemented.' }, checkpoints: [] } };
  const state = { features: [feature], submissions: [submission], events: [],
    dispatches: [{ dispatchId: 'd33', execution: { implementationContinuation: context } }],
    attempts: { [submission.attemptBudgetKey]: { failures: 33, limit: 41, exhausted: false } } };
  return { state, feature, submission, context, commandId: 'explicit-command' };
};

test('unchanged implementation-only handoff is corrected once without rewriting submission or budget', () => {
  const f = fixture(); const before = digestJson(f.state);
  assert.equal(shouldCorrectImplementationHandoff(f), true);
  const reason = implementationHandoffCorrectionReason(f.commandId, f.feature, f.context);
  assert.match(reason, /First implement and wire the approved target src\/target/);
  assert.match(reason, /missing owner dependencies before its thin consumer/);
  assert.match(reason, /not an external blocker/);
  assert.equal(digestJson(f.state), before);
  f.state.events.push({ type: 'feature.reopened', featureId: f.feature.id, reason });
  assert.equal(shouldCorrectImplementationHandoff(f), false);
  // A later explicit invocation still uses the same accumulated attempt ledger.
  assert.equal(shouldCorrectImplementationHandoff({ ...f, commandId: 'next-explicit-command' }), true);
  assert.equal(f.state.attempts[f.submission.attemptBudgetKey].failures, 33);
});

test('correction cannot cross protected blockers, missing evidence, legacy dispatches or exhausted budgets', () => {
  for (const kind of ['authority', 'approval', 'external', 'environment', 'scope', 'permission-denied']) {
    const f = fixture(); f.submission.result.blocker.kind = kind;
    assert.equal(shouldCorrectImplementationHandoff(f), false);
  }
  for (const mutate of [f => { f.submission.evidenceRefs = []; }, f => { f.feature.metadata.stage = 'quality'; },
    f => { f.submission.result.status = 'completed'; }, f => { f.submission.result.failureClass = 'external-dependency'; },
    f => { delete f.context.correctionPolicy; }, f => { f.state.attempts[f.submission.attemptBudgetKey].exhausted = true; }]) {
    const f = fixture(); mutate(f); assert.equal(shouldCorrectImplementationHandoff(f), false);
  }
});

test('only changed approved targets with implementation AND focused evidence advance partial development', () => {
  const f = fixture();
  const progress = () => shouldContinueImplementationProgress({ ...f, result: f.submission.result });
  assert.equal(progress(), false);
  f.submission.outputSourceDigest = 'new'; f.submission.changedFiles = ['tests/more-cases'];
  f.submission.result.checkpoints = [{ id: 'implementation-step:target', status: 'completed', evidence: ['source-hash'] },
    { id: 'implementation-step:target:focused-verification', status: 'completed', evidence: ['compile-log'] }];
  assert.equal(progress(), false);
  f.submission.changedFiles = ['src/target']; assert.equal(progress(), true);
  f.submission.result.checkpoints.pop(); assert.equal(progress(), false);
  f.submission.result.checkpoints.push({ id: 'implementation-step:target:focused-verification', status: 'completed', evidence: [] });
  assert.equal(progress(), false);
  f.submission.result.checkpoints[1].evidence = ['compile-log'];
  f.state.submissions.unshift({ submissionId: 'older', featureId: f.feature.id, inputSourceDigest: 'new', outputSourceDigest: 'source' });
  assert.equal(hasTargetImplementationProgress(f.state, f.feature, f.submission, f.context), false);
  assert.equal(shouldCorrectImplementationHandoff(f), false);
});

test('controlled no-op to target implementation to acceptance sequence remains bounded and distinct', () => {
  const f = fixture();
  assert.equal(shouldCorrectImplementationHandoff(f), true);
  f.state.events.push({ type: 'feature.reopened', featureId: f.feature.id,
    reason: `${correctionReasonPrefix(f.commandId, f.feature.id)} correction requested` });
  const second = structuredClone(f.submission); second.submissionId = 's34'; second.dispatchId = 'd34';
  second.outputSourceDigest = 'implemented'; second.changedFiles = ['src/target'];
  second.result.checkpoints = [{ id: 'implementation-step:target', status: 'completed', evidence: ['source-implemented'] },
    { id: 'implementation-step:target:focused-verification', status: 'completed', evidence: ['compiled'] }];
  f.state.dispatches.push({ dispatchId: 'd34', execution: { implementationContinuation: f.context } });
  f.state.submissions.push(second); f.state.attempts[second.attemptBudgetKey].failures = 34;
  assert.equal(shouldContinueImplementationProgress({ state: f.state, feature: f.feature, submission: second, result: second.result }), true);
  assert.equal(second.result.status, 'blocked');
  assert.equal(second.result.outputs, undefined); // No acceptance output is synthesized.
  assert.equal(shouldCorrectImplementationHandoff({ ...f, submission: second }), false);
  f.state.attempts[second.attemptBudgetKey].exhausted = true;
  assert.equal(shouldContinueImplementationProgress({ state: f.state, feature: f.feature, submission: second, result: second.result }), false);
});

test('managed correction dispatch implements an approved target and preserves the actual submission ledger', async t => {
  const f = await makeFixture(); t.after(f.cleanup);
  const plan = { sourceLifecycleContract: { sources: [{ sourcePath: 'src/old.mjs', lastExitFeature: 'owner', finalPaths: ['src/target.mjs'] }] } };
  const bytes = JSON.stringify(plan);
  await writeFile(resolve(f.workspace, 'plan.json'), bytes);
  const proposal = { id: 'owner', projectId: f.projectId, disposition: 'project-owned', contracts: ['Implement owner.'], verification: ['Verify owner.'] };
  const item = makeFeature('owner', { stage: 'implementation', implementationProgressRetries: 20,
    approvedProposal: proposal, approvedDeliveryPlan: { proposedFeatures: [proposal], expandedPlan: { path: 'plan.json', sha256: sha256(bytes) } } },
  { allowedPaths: ['src'], attemptLimit: 5 });
  await startRun(f, { features: [item] });
  const first = await dispatchAndBind(f, 'run');
  const context = first.dispatch.execution.implementationContinuation;
  assert.equal(context.nextImplementationStep.targetPath, 'src/target.mjs');
  let s = (await recordResult(f, 'run', first.dispatch, { status: 'blocked', summary: 'Target and certificates missing.', changedFiles: [],
    failureClass: 'implementation-incomplete', blocker: { kind: 'implementation', summary: 'Owner unfinished.' } })).state;
  const noOp = s.submissions.at(-1);
  assert.equal(shouldCorrectImplementationHandoff({ state: s, feature: s.features[0], submission: noOp, commandId: 'invoke' }), true);
  s = (await f.harness.kernel.reopenFeature(f.projectId, 'run', { featureId: item.id,
    reason: implementationHandoffCorrectionReason('invoke', s.features[0], context) }, command(s))).state;
  const second = await dispatchAndBind(f, 'run');
  assert.match(second.dispatch.featureSnapshot.reopenReason, /First implement and wire/);
  await mkdir(resolve(f.workspace, 'src'));
  await writeFile(resolve(f.workspace, 'src/target.mjs'), 'export const ownerValue = () => 7;\n');
  const implementation = await import(pathToFileURL(resolve(f.workspace, 'src/target.mjs')).href);
  assert.equal(implementation.ownerValue(), 7);
  const step = context.nextImplementationStep;
  s = (await recordResult(f, 'run', second.dispatch, { status: 'blocked', summary: 'Final target implemented and executed; aggregate certification remains.',
    changedFiles: ['src/target.mjs'], failureClass: 'implementation-incomplete', blocker: { kind: 'implementation', summary: 'Complete behavior certificates.' },
    checkpoints: [{ id: step.id, status: 'completed', summary: 'Approved target implemented.', evidence: ['src/target.mjs'] },
      { id: `${step.id}:focused-verification`, status: 'completed', summary: 'Module loaded and ownerValue returned 7.', evidence: ['executed-module:7'] }] })).state;
  assert.equal(s.submissions.length, 2);
  assert.deepEqual(s.submissions[0].changedFiles, []);
  assert.deepEqual(s.submissions[1].changedFiles, ['src/target.mjs']);
  assert.equal(s.attempts[s.submissions[1].attemptBudgetKey].failures, 2);
  assert.equal(shouldContinueImplementationProgress({ state: s, feature: s.features[0], submission: s.submissions[1], result: s.submissions[1].result }), true);
  assert.equal(s.features[0].state, 'blocked');
  assert.equal(s.submissions[1].result.outputs, undefined);
});
