import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliveryLifecycleProfile } from '../src/flows/delivery-lifecycle/policy/delivery-lifecycle.mjs';
import { ensurePlanApprovalArtifact, planApprovalSatisfied, planApprovalSnapshot } from '../src/flows/delivery-lifecycle/plan-approval.mjs';

const reviewedRun = approved => ({
  projectId: 'sample', runId: 'plan-1', sourceDigest: 'a'.repeat(64),
  metadata: { commandIntent: { action: 'plan', target: 'V1' } },
  profile: { config: { requireCanonicalDecision: false, requireUserCodeReview: false, requiredFinalGates: [] } },
  features: [
    { id: 'planner', state: 'completed', metadata: { stage: 'version-planning' } },
    { id: 'reviewer', state: 'completed', metadata: { stage: 'plan-review' } },
  ],
  submissions: [
    { featureId: 'planner', result: { status: 'completed', outputs: { plan: { value: { proposedFeatures: [
      { id: 'engine', projectId: 'sample', disposition: 'project-owned', allowedPaths: ['src'], dependsOn: [], contracts: ['API stable'], verification: ['tests pass'] },
    ], acceptanceCoverage: { gate: ['engine'] } } } } } },
    { featureId: 'reviewer', result: { status: 'completed', outputs: { 'plan-review': { value: { approved, findings: approved ? [] : ['Missing path'] } } } } },
  ],
  decisions: [], gates: [],
});

test('reviewed plan writes Markdown and blocks closure and implementation until the exact user decision', async t => {
  const root = await mkdtemp(join(tmpdir(), 'harness-plan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = reviewedRun(true);
  const artifact = await ensurePlanApprovalArtifact(root, state);
  assert.match(await readFile(artifact.path, 'utf8'), /engine.*sample.*project-owned/);
  assert.match(await readFile(artifact.path, 'utf8'), /此处尚无人工批准/);
  assert.deepEqual(deliveryLifecycleProfile.canClose(state), { ok: false, reason: 'implementation-plan-user-approval-required' });
  assert.deepEqual(deliveryLifecycleProfile.canDispatch({ metadata: { stage: 'implementation' } }, state), { ok: false, reason: 'implementation-plan-user-approval-required' });
  const decision = { id: 'implementation-plan-approved', actor: 'user', decision: 'approved', projectId: state.projectId, runId: state.runId, planDigest: artifact.planDigest, artifactDigest: artifact.artifactDigest };
  assert.equal(planApprovalSatisfied({ ...state, decisions: [{ ...decision, artifactDigest: 'b'.repeat(64) }] }), false);
  state.decisions.push(decision);
  assert.equal(planApprovalSatisfied(state), true);
  assert.deepEqual(deliveryLifecycleProfile.canClose(state), { ok: true });
  assert.equal(planApprovalSnapshot({ ...state, runId: 'other' }).planDigest === artifact.planDigest, false);
});

test('negative independent review still produces a Markdown finding and cannot be approved', async t => {
  const root = await mkdtemp(join(tmpdir(), 'harness-plan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = reviewedRun(false);
  const artifact = await ensurePlanApprovalArtifact(root, state);
  assert.match(await readFile(artifact.path, 'utf8'), /Missing path/);
  assert.equal(artifact.reviewApproved, false);
  assert.equal(planApprovalSatisfied({ ...state, decisions: [{ id: 'implementation-plan-approved', actor: 'user', decision: 'approved', ...artifact }] }), false);
});
