import test from 'node:test';
import assert from 'node:assert/strict';
import { digestJson } from '../src/common/canonical.mjs';
import { createCompletionCarryoverPlan, verifyCompletionCarryover } from '../src/kernel/completion-carryover.mjs';
import { selectBlockedResumeFeature } from '../src/application/lifecycle-resume.mjs';
import { makeFixture, feature } from './test-support.mjs';

test('idle migration before the first child completion preserves partial evidence, every counter and protected blockers', async t => {
  const f = await makeFixture(); t.after(f.cleanup);
  const { kernel, authorityStore, evidenceStore } = f.harness;
  const sourceDigest = 'a'.repeat(64), planDigest = 'b'.repeat(64);
  let features = ['spatial', 'diagnostics'].map(id => feature(id, { stage: 'implementation' }, { logicalRoot: `feature:${id}` }));
  const started = await kernel.startRun({ projectId: f.projectId, runId: 'prior', profileId: 'feature-delivery',
    features, sourceDigest, pluginSetDigest: 'c'.repeat(64), metadata: { commandIntent: { action: 'implement' } } },
  { commandId: 'start' });
  features = structuredClone(started.state.features);
  const submissions = [];
  for (const [index, id] of ['spatial', 'diagnostics'].entries()) {
    const result = { status: index ? 'blocked' : 'failed', summary: `${id} partial`, changedFiles: [],
      failureClass: index ? 'scope-blocker' : 'implementation-incomplete',
      blocker: index ? { kind: 'scope', repairCandidatePaths: ['src/held.mjs'] } : { kind: 'implementation-gap' } };
    const evidence = await evidenceStore.put(JSON.stringify(result), { projectId: f.projectId, runId: 'prior',
      epoch: 1, generation: 1, featureId: id, dispatchId: `d-${id}`, sourceDigest });
    const body = { submissionId: `s-${id}`, dispatchId: `d-${id}`, leaseId: `l-${id}`, featureId: id, agentId: `a-${id}`,
      epoch: 1, generation: 1, inputSourceDigest: sourceDigest, outputSourceDigest: sourceDigest, changedFiles: [],
      result, evidenceRefs: [evidence.ref], submittedAt: '2026-10-29T00:00:00Z' };
    submissions.push({ ...body, submissionDigest: digestJson(body) });
  }
  const prior = (await authorityStore.transact(f.projectId, 'prior', { expectedRevision: started.state.revision,
    commandId: 'partial-fixture' }, state => {
    for (const item of submissions) {
      state.submissions.push(item);
      state.dispatches.push({ dispatchId: item.dispatchId, featureId: item.featureId, status: 'committed' });
      const target = state.features.find(row => row.id === item.featureId);
      target.state = 'blocked'; target.submissionId = item.submissionId; target.blocker = item.result.blocker;
    }
    state.attempts = {
      'feature:spatial:progress': { key: 'feature:spatial:progress', logicalRoot: 'feature:spatial', budgetKind: 'progress',
        used: 21, failures: 0, limit: 41, exhausted: false, records: Array.from({ length: 21 }, (_, i) => ({ summary: `old ${i}` })) },
      'feature:spatial:implementation-incomplete': { key: 'feature:spatial:implementation-incomplete', logicalRoot: 'feature:spatial',
        budgetKind: 'failure', failures: 1, limit: 3, exhausted: false, records: [{ submissionId: 's-spatial' }] },
    };
    state.metadata.attemptBudgetExtensions = [{ logicalRoot: 'feature:spatial', additional: 20, approvalDigest: 'exact-approval' }];
  })).state;
  // Test support's logical root is explicit; no production counter inference.
  assert.equal(prior.features[0].logicalRoot, 'feature:spatial');
  const input = { prior, replacementFeatures: features, replacementRunId: 'replacement',
    replacementPlanDigest: planDigest, patchReceiptDigest: 'd'.repeat(64), sourceDigest };
  assert.throws(() => createCompletionCarryoverPlan(input), { code: 'CARRYOVER_NO_COMPLETIONS' });
  const plan = createCompletionCarryoverPlan({ ...input, includeIncomplete: true });
  assert.equal(plan.progressOnly, true); assert.deepEqual(plan.completedSubmissions, []);
  assert.equal(plan.partialSubmissions.length, 2);
  await verifyCompletionCarryover({ plan, prior, replacementFeatures: features, evidenceStore });
  await assert.rejects(() => verifyCompletionCarryover({ plan, prior, replacementFeatures: features,
    evidenceStore: { read: async ref => ({ ...(await evidenceStore.read(ref)), metadata: { runId: 'wrong' } }) } }),
  { code: 'CARRYOVER_EVIDENCE_CONTEXT_MISMATCH' });
  await kernel.supersedeRun(f.projectId, 'prior', { replacementRunId: 'replacement', planDigest,
    reason: 'development-h4-recovery:test', completionCarryover: { plan, replacementPlan: { planDigest, run: { runId: 'replacement' } } } },
  { expectedRevision: prior.revision, commandId: 'retire' });
  const replacement = (await kernel.startRun({ projectId: f.projectId, runId: 'replacement', profileId: 'feature-delivery',
    features, sourceDigest, pluginSetDigest: 'c'.repeat(64), metadata: { commandIntent: { action: 'implement' }, lifecyclePlanDigest: planDigest },
    completionCarryover: { priorRunId: 'prior', carryoverDigest: plan.carryoverDigest } }, { commandId: 'replace' })).state;
  assert.deepEqual(replacement.attempts, prior.attempts);
  assert.deepEqual(replacement.metadata.attemptBudgetExtensions, prior.metadata.attemptBudgetExtensions);
  assert.deepEqual(replacement.submissions, prior.submissions);
  assert.deepEqual(replacement.features.map(row => [row.id, row.state, row.blocker]), prior.features.map(row => [row.id, row.state, row.blocker]));
  assert.equal(selectBlockedResumeFeature(replacement), 'spatial');
  assert.equal(replacement.leases.length, 0); assert.equal(replacement.dispatches.length, 0);
});
