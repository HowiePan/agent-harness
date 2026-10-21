import assert from 'node:assert/strict';
import test from 'node:test';
import { digestJson } from '../src/common/canonical.mjs';
import { createCompletionCarryoverPlan } from '../src/kernel/completion-carryover.mjs';
import { prepareBudgetExtension } from '../src/kernel/attempt-budget.mjs';
import { feature, makeFixture } from './test-support.mjs';

test('H4 carry-over preserves exhausted budgets, incomplete history and approved additions without starting over', async t => {
  const fixture = await makeFixture(); t.after(fixture.cleanup);
  const { kernel, authorityStore, evidenceStore } = fixture.harness;
  const sourceDigest = 'a'.repeat(64);
  const started = await kernel.startRun({ projectId: fixture.projectId, runId: 'before-budget-patch',
    profileId: 'feature-delivery', sourceDigest, pluginSetDigest: 'b'.repeat(64),
    features: [feature('done', { stage: 'implementation' }), feature('remaining', { stage: 'implementation' }, { dependsOn: ['done'] })],
    metadata: { commandIntent: { action: 'implement' }, lifecyclePlanDigest: 'c'.repeat(64) } }, { commandId: 'start' });
  const evidence = await evidenceStore.put('completed evidence', { projectId: fixture.projectId, runId: started.state.runId,
    epoch: 1, generation: 1, featureId: 'done', dispatchId: 'done-dispatch', sourceDigest });
  const completed = { submissionId: 'completed', dispatchId: 'done-dispatch', featureId: 'done', inputSourceDigest: sourceDigest,
    result: { status: 'completed' }, evidenceRefs: [evidence.ref] };
  completed.submissionDigest = digestJson(completed);
  const incomplete = { submissionId: 'incomplete', featureId: 'remaining', inputSourceDigest: 'd'.repeat(64), outputSourceDigest: sourceDigest,
    result: { status: 'blocked', failureClass: 'implementation-incomplete', blocker: { kind: 'in-scope-fix-blocked', summary: 'Work remains.' } }, evidenceRefs: [] };
  incomplete.submissionDigest = digestJson(incomplete);
  const prior = (await authorityStore.transact(fixture.projectId, started.state.runId,
    { expectedRevision: started.state.revision, commandId: 'seed-attempt-history', payload: {} }, state => {
      state.features[0].state = 'completed'; state.features[0].submissionId = completed.submissionId;
      state.features[1].state = 'failed-budget';
      state.submissions = [completed, incomplete];
      state.attempts = { 'remaining:implementation-incomplete': { key: 'remaining:implementation-incomplete', logicalRoot: 'remaining',
        failures: 21, limit: 21, exhausted: true, records: [{ submissionId: incomplete.submissionId }] } };
      state.metadata.attemptBudgetExtensions = [{ logicalRoot: 'done', additional: 2, approval: { id: 'prior-budget-approval' } }];
    })).state;
  const features = prior.features.map(item => ({ ...item, state: 'pending' }));
  const replacementPlanDigest = 'e'.repeat(64);
  const plan = createCompletionCarryoverPlan({ prior, replacementFeatures: features, replacementRunId: 'after-budget-patch',
    replacementPlanDigest, patchReceiptDigest: 'f'.repeat(64), sourceDigest });
  await kernel.supersedeRun(fixture.projectId, prior.runId, { replacementRunId: 'after-budget-patch', planDigest: replacementPlanDigest,
    completionCarryover: { plan, replacementPlan: { planDigest: replacementPlanDigest, run: { runId: 'after-budget-patch' } } } },
  { expectedRevision: prior.revision, commandId: 'retire' });
  const replacement = (await kernel.startRun({ projectId: fixture.projectId, runId: 'after-budget-patch', profileId: 'feature-delivery',
    features, sourceDigest, pluginSetDigest: 'b'.repeat(64),
    metadata: { lifecyclePlanDigest: replacementPlanDigest, attemptAccounting: 'separate-progress-v1' },
    completionCarryover: { priorRunId: prior.runId, carryoverDigest: plan.carryoverDigest } }, { commandId: 'start-replacement' })).state;
  assert.equal(replacement.features[0].state, 'completed');
  assert.equal(replacement.features[1].state, 'failed-budget');
  assert.equal(replacement.metadata.attemptAccounting, undefined);
  assert.deepEqual(replacement.metadata.attemptBudgetExtensions, prior.metadata.attemptBudgetExtensions);
  assert.deepEqual(replacement.attempts, prior.attempts);
  assert.deepEqual(replacement.submissions, prior.submissions);
  assert.equal(replacement.dispatches.length, 0);
  const proposal = prepareBudgetExtension({ state: replacement, featureId: 'remaining', attemptKey: 'remaining:implementation-incomplete',
    additional: 20, reason: 'Continue the unchanged work after the patch.', remainingWork: ['Finish it.'] });
  assert.equal(proposal.used, 21); assert.equal(proposal.afterLimit, 41);
});
