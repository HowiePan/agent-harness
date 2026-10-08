import test from 'node:test';
import assert from 'node:assert/strict';
import { digestJson } from '../src/common/canonical.mjs';
import { createCompletionCarryoverPlan, selectCompletionCarryoverSource, verifyCompletionCarryover } from '../src/kernel/completion-carryover.mjs';
import { buildDispatchPacket } from '../src/kernel/kernel.mjs';
import { feature, makeFixture } from './test-support.mjs';

const code = expected => error => error.code === expected;

test('verified completion prefix carries into one replacement Run and resumes at the first pending Feature', async () => {
  const fixture = await makeFixture();
  try {
    const { kernel, authorityStore, evidenceStore } = fixture.harness;
    const sourceDigest = 'a'.repeat(64);
    const oldRunId = 'old-implementation';
    const newRunId = 'new-implementation';
    const replacementPlanDigest = 'b'.repeat(64);
    const features = [feature('F00', { stage: 'implementation' }),
      feature('F06', { stage: 'implementation' }, { dependsOn: ['F00'] })];
    const started = await kernel.startRun({ projectId: fixture.projectId, runId: oldRunId,
      profileId: 'feature-delivery', features, sourceDigest, pluginSetDigest: 'c'.repeat(64),
      metadata: { commandIntent: { action: 'implement' }, lifecyclePlanDigest: 'd'.repeat(64) } },
    { commandId: 'carry-old-start' });
    const evidence = await evidenceStore.put('verified F00 output', { projectId: fixture.projectId,
      runId: oldRunId, epoch: 1, generation: 1, featureId: 'F00', dispatchId: 'dispatch-F00', sourceDigest });
    const submission = { submissionId: 'submission-F00', dispatchId: 'dispatch-F00', leaseId: 'lease-F00',
      featureId: 'F00', agentId: 'agent-F00', epoch: 1, generation: 1, inputSourceDigest: sourceDigest,
      outputSourceDigest: sourceDigest, changedFiles: [], result: { status: 'completed', summary: 'F00 verified',
        changedFiles: [], outputs: { progress: { schemaId: 'test-progress', value: { done: true }, evidenceRefs: [evidence.ref] } } },
      evidenceRefs: [evidence.ref], submittedAt: '2026-10-07T00:00:00.000Z' };
    submission.submissionDigest = digestJson(submission);
    const advanced = await authorityStore.transact(fixture.projectId, oldRunId,
      { expectedRevision: started.state.revision, commandId: 'carry-old-complete' }, state => {
        state.features[0].state = 'completed';
        state.features[0].submissionId = submission.submissionId;
        state.features[1].state = 'blocked';
        state.submissions.push(submission);
        state.submissions.push({ submissionId: 'submission-F06-blocked', dispatchId: 'dispatch-F06',
          featureId: 'F06', inputSourceDigest: sourceDigest,
          result: { status: 'blocked', summary: 'F06 performance threshold remains', failureClass: 'implementation-incomplete' },
          evidenceRefs: [] });
        state.evidenceRefs.push(evidence.ref);
      });
    const prior = advanced.state;
    const replacementFeatures = prior.features.map(item => {
      const replacement = structuredClone(item);
      replacement.state = 'pending';
      delete replacement.submissionId;
      return replacement;
    });
    const plan = createCompletionCarryoverPlan({ prior, replacementFeatures, replacementRunId: newRunId,
      replacementPlanDigest, patchReceiptDigest: 'e'.repeat(64), sourceDigest });
    await verifyCompletionCarryover({ plan, prior, replacementFeatures, evidenceStore });
    await assert.rejects(verifyCompletionCarryover({ plan, prior,
      replacementFeatures: replacementFeatures.map(item => item.id === 'F00' ? { ...item, allowedPaths: ['different'] } : item),
      evidenceStore }), code('CARRYOVER_PLAN_MISMATCH'));
    await assert.rejects(verifyCompletionCarryover({ plan, prior, replacementFeatures,
      evidenceStore: { read: async ref => ({ metadata: { ...(await evidenceStore.read(ref)).metadata,
        runId: 'unrelated-run' } }) } }), code('CARRYOVER_EVIDENCE_CONTEXT_MISMATCH'));
    const gap = structuredClone(prior);
    gap.features[0].state = 'pending';
    gap.features[1].state = 'completed';
    assert.throws(() => createCompletionCarryoverPlan({ prior: gap, replacementFeatures,
      replacementRunId: newRunId, replacementPlanDigest, patchReceiptDigest: 'e'.repeat(64), sourceDigest }),
    code('CARRYOVER_COMPLETION_ORDER_INVALID'));
    assert.throws(() => createCompletionCarryoverPlan({ prior, replacementFeatures, replacementRunId: newRunId,
      replacementPlanDigest, patchReceiptDigest: 'e'.repeat(64), sourceDigest: 'f'.repeat(64) }),
    code('CARRYOVER_SOURCE_CHANGED'));
    const retired = await kernel.supersedeRun(fixture.projectId, oldRunId, {
      replacementRunId: newRunId, planDigest: replacementPlanDigest, reason: 'test-h3-recovery',
      completionCarryover: { plan, replacementPlan: { planDigest: replacementPlanDigest, run: { runId: newRunId } } },
    }, { expectedRevision: prior.revision, commandId: 'carry-old-retire' });
    assert.equal(retired.state.status, 'superseded');
    assert.equal(selectCompletionCarryoverSource([retired.state],
      { run: { runId: newRunId }, planDigest: replacementPlanDigest }).runId, oldRunId);
    assert.throws(() => selectCompletionCarryoverSource([retired.state, retired.state],
      { run: { runId: newRunId }, planDigest: replacementPlanDigest }), code('CARRYOVER_SOURCE_AMBIGUOUS'));
    const replacement = await kernel.startRun({ projectId: fixture.projectId, runId: newRunId,
      profileId: 'feature-delivery', features: replacementFeatures, sourceDigest,
      pluginSetDigest: 'c'.repeat(64), metadata: { commandIntent: { action: 'implement' },
        lifecyclePlanDigest: replacementPlanDigest }, completionCarryover: { priorRunId: oldRunId,
        carryoverDigest: plan.carryoverDigest } }, { commandId: 'carry-new-start' });
    assert.deepEqual(replacement.state.features.map(item => [item.id, item.state]),
      [['F00', 'completed'], ['F06', 'pending']]);
    assert.equal(replacement.state.metadata.completionCarryover.firstPendingFeatureId, 'F06');
    assert.match(replacement.state.features[1].reopenReason, /F06 performance threshold remains/);
    assert.equal(replacement.state.submissions[0].submissionDigest, submission.submissionDigest);
    const packet = buildDispatchPacket(replacement.state, { dispatchId: 'dispatch-new-F06',
      sourceDigest, sourceSnapshotRef: evidence.ref, outputRef: 'test-output', gateSnapshot: [], execution: {} },
    replacement.state.features[1]);
    assert.equal(packet.workflowContext.upstreamOutputs.F00.progress.value.done, true);
    const retry = await kernel.startRun({ projectId: fixture.projectId, runId: newRunId,
      profileId: 'feature-delivery', features: replacementFeatures, sourceDigest,
      pluginSetDigest: 'c'.repeat(64), metadata: { commandIntent: { action: 'implement' },
        lifecyclePlanDigest: replacementPlanDigest }, completionCarryover: { priorRunId: oldRunId,
        carryoverDigest: plan.carryoverDigest } }, { commandId: 'carry-new-start' });
    assert.equal(retry.reused, true);
    assert.equal((await authorityStore.list(fixture.projectId)).length, 2);
    const secondRunId = 'second-replacement';
    const secondPlanDigest = 'f'.repeat(64);
    const secondPlan = createCompletionCarryoverPlan({ prior: replacement.state, replacementFeatures,
      replacementRunId: secondRunId, replacementPlanDigest: secondPlanDigest,
      patchReceiptDigest: '1'.repeat(64), sourceDigest });
    await verifyCompletionCarryover({ plan: secondPlan, prior: replacement.state,
      replacementFeatures, evidenceStore, authorityStore });
    const secondRetired = await kernel.supersedeRun(fixture.projectId, newRunId, {
      replacementRunId: secondRunId, planDigest: secondPlanDigest, reason: 'test-second-h3-recovery',
      completionCarryover: { plan: secondPlan, replacementPlan: { planDigest: secondPlanDigest,
        run: { runId: secondRunId } } },
    }, { expectedRevision: replacement.state.revision, commandId: 'carry-second-retire' });
    assert.equal(secondRetired.state.status, 'superseded');
    const second = await kernel.startRun({ projectId: fixture.projectId, runId: secondRunId,
      profileId: 'feature-delivery', features: replacementFeatures, sourceDigest,
      pluginSetDigest: 'c'.repeat(64), metadata: { commandIntent: { action: 'implement' },
        lifecyclePlanDigest: secondPlanDigest }, completionCarryover: { priorRunId: newRunId,
        carryoverDigest: secondPlan.carryoverDigest } }, { commandId: 'carry-second-start' });
    assert.deepEqual(second.state.features.map(item => [item.id, item.state]),
      [['F00', 'completed'], ['F06', 'pending']]);
  } finally { await fixture.cleanup(); }
});
