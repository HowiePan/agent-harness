import test from 'node:test';
import assert from 'node:assert/strict';
import { assessVerifiedImplementationContinuation } from '../src/application/plan-source-compatibility.mjs';
import { completionCarryoverDigest, implementationGraphDigest } from '../src/kernel/completion-carryover.mjs';

const fixture = () => {
  const binding = { runId: 'plan', planDigest: 'approved-plan', artifactDigest: 'approved-artifact',
    originalSourceDigest: 'reviewed', sourceDigest: 'approved-start' };
  const inherited = { submissionId: 'inherited', dispatchId: 'old-dispatch', featureId: 'feature',
    inputSourceDigest: 'older-start', outputSourceDigest: 'older-end', changedFiles: ['src/old'],
    evidenceRefs: ['old-evidence'], submissionDigest: 'old-submission' };
  const current = { submissionId: 'current', dispatchId: 'current-dispatch', featureId: 'feature',
    inputSourceDigest: 'approved-start', outputSourceDigest: 'current-source', changedFiles: ['src/owner'],
    evidenceRefs: ['current-evidence'], submissionDigest: 'current-submission' };
  const run = { projectId: 'project', runId: 'implementation', sourceDigest: 'current-source', leases: [],
    metadata: { commandIntent: { action: 'implement', target: 'V1' }, workflow: { id: 'delivery' },
      workspace: { root: process.cwd() }, approvedPlan: binding,
      attemptCarryover: { submissionIds: [inherited.submissionId], sources: [{ runId: 'old-authority' }] } },
    features: [{ id: 'feature', allowedPaths: ['src'] }],
    dispatches: [{ dispatchId: current.dispatchId, status: 'committed' }], submissions: [inherited, current] };
  return { run, input: { planRun: { projectId: 'project', runId: 'plan', sourceDigest: 'reviewed',
    metadata: { commandIntent: { target: 'V1' }, workflow: { id: 'delivery' } } },
  planArtifact: binding, priorRuns: [run], currentSourceDigest: run.sourceDigest,
  workspaceRoot: process.cwd(), implementationFeatures: [{ metadata: { stage: 'implementation' }, allowedPaths: ['src'] }] } };
};

test('inherited accounting history is preserved but does not prepend a foreign source chain to the approved start', () => {
  const { input, run } = fixture(); const before = structuredClone(run);
  assert.deepEqual(assessVerifiedImplementationContinuation(input), {
    mode: 'verified-prior-implementation', priorRunId: run.runId, fromSourceDigest: 'approved-start',
    toSourceDigest: 'current-source', submissionDigests: ['current-submission'] });
  assert.deepEqual(run, before);
});

test('unmarked history and local Dispatch deltas cannot be discarded to manufacture source compatibility', () => {
  const f = fixture(); f.run.metadata.attemptCarryover.submissionIds = [];
  assert.equal(assessVerifiedImplementationContinuation(f.input), null);
  f.run.metadata.attemptCarryover.submissionIds = ['inherited'];
  f.run.dispatches.push({ dispatchId: 'old-dispatch', status: 'committed' });
  assert.equal(assessVerifiedImplementationContinuation(f.input), null);
});

test('inherited rows do not authorize unrelated changes, stale digests, or a missing current implementation chain', () => {
  for (const mutate of [f => { f.run.submissions[1].changedFiles = ['outside/owner']; },
    f => { f.run.submissions[1].inputSourceDigest = 'unbound'; },
    f => { f.run.submissions[1].evidenceRefs = []; },
    f => { f.run.submissions.pop(); },
    f => { f.input.currentSourceDigest = 'workspace-drift'; }]) {
    const f = fixture(); mutate(f);
    assert.equal(assessVerifiedImplementationContinuation(f.input), null);
  }
});

const carriedFixture = () => {
  const f = fixture(); const parent = f.run;
  parent.features[0].metadata = { stage: 'implementation' };
  const child = structuredClone(parent);
  child.runId = 'patched-implementation'; child.sourceDigest = 'after-patch-progress';
  child.metadata.lifecyclePlanDigest = 'replacement-plan';
  child.metadata.attemptCarryover.submissionIds.push('current');
  const next = { ...structuredClone(parent.submissions[1]), submissionId: 'next', dispatchId: 'next-dispatch',
    inputSourceDigest: parent.sourceDigest, outputSourceDigest: child.sourceDigest, submissionDigest: 'next-submission' };
  child.submissions.push(next); child.dispatches = [{ dispatchId: next.dispatchId, status: 'committed' }];
  parent.status = 'superseded'; parent.metadata.supersededByRunId = child.runId;
  parent.metadata.supersedePlanDigest = child.metadata.lifecyclePlanDigest;
  const claim = { priorRunId: parent.runId, replacementRunId: child.runId,
    replacementPlanDigest: child.metadata.lifecyclePlanDigest, sourceDigest: parent.sourceDigest,
    implementationGraphDigest: implementationGraphDigest(parent.features) };
  claim.carryoverDigest = completionCarryoverDigest(claim);
  parent.metadata.completionCarryover = { plan: claim };
  child.events = [{ type: 'feature.completion-carried-over', priorRunId: parent.runId, carryoverDigest: claim.carryoverDigest }];
  f.input.priorRuns = [child, parent]; f.input.currentSourceDigest = child.sourceDigest;
  return { ...f, parent, child };
};

test('source continuity follows the sealed patch lineage before validating new local deltas', () => {
  const f = carriedFixture(); const before = structuredClone(f.input);
  assert.deepEqual(assessVerifiedImplementationContinuation(f.input), {
    mode: 'verified-prior-implementation', priorRunId: f.child.runId, fromSourceDigest: 'approved-start',
    toSourceDigest: f.child.sourceDigest, submissionDigests: ['current-submission', 'next-submission'] });
  assert.deepEqual(f.input, before);
});

test('patch lineage cannot substitute approval, graph, parent, source, evidence or uncommitted drift', () => {
  for (const mutate of [f => { f.input.priorRuns.pop(); },
    f => { f.parent.status = 'ready'; },
    f => { f.parent.metadata.supersededByRunId = 'unrelated'; },
    f => { f.child.metadata.lifecyclePlanDigest = 'unbound-plan'; },
    f => { f.child.events[0].carryoverDigest = 'substituted'; },
    f => { f.parent.metadata.completionCarryover.plan.sourceDigest = 'unbound-source'; },
    f => { f.parent.metadata.approvedPlan.planDigest = 'other-approval'; },
    f => { f.parent.metadata.workspace.root = '/another-checkout'; },
    f => { f.child.features[0].allowedPaths.push('outside'); },
    f => { f.child.submissions.at(-1).inputSourceDigest = 'unbound-input'; },
    f => { f.child.submissions.at(-1).evidenceRefs = []; },
    f => { f.child.submissions.at(-1).changedFiles = ['outside/owner']; },
    f => { f.input.currentSourceDigest = f.child.sourceDigest = 'uncommitted-drift'; }]) {
    const f = carriedFixture(); mutate(f);
    assert.equal(assessVerifiedImplementationContinuation(f.input), null);
  }
});
