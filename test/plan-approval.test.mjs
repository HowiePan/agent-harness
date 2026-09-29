import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliveryLifecycleProfile } from '../src/flows/delivery-lifecycle/policy/delivery-lifecycle.mjs';
import { ensurePlanApprovalArtifact, planApprovalSatisfied, planApprovalSnapshot } from '../src/flows/delivery-lifecycle/plan-approval.mjs';
import { assessPlanSourceCompatibility, planSourceCompatibilitySatisfied } from '../src/application/plan-source-compatibility.mjs';
import { captureWorkspace } from '../src/common/workspace-snapshot.mjs';
import { command, feature, makeFixture } from './test-support.mjs';

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

test('approved plan can bind an audited source delta while later engine edits still invalidate it', () => {
  const state = reviewedRun(true);
  const plan = planApprovalSnapshot(state);
  const baselineSnapshot = { digest: state.sourceDigest, files: [
    { path: 'card_world_engine/src/lib.rs', sha256: '1', size: 1 },
    { path: 'docs/versions/v1.md', sha256: '2', size: 1 },
    { path: 'tabletop-collection/games/a.ts', sha256: '3', size: 1 },
  ] };
  const currentSnapshot = { digest: 'b'.repeat(64), files: [
    { path: 'card_world_engine/src/lib.rs', sha256: '1', size: 1 },
    { path: 'docs/versions/v1.md', sha256: '4', size: 1 },
    { path: 'docs/versions/v1-execution-plan-review.md', sha256: '5', size: 1 },
  ] };
  const assessment = assessPlanSourceCompatibility({ planRun: state, baselineSnapshot, currentSnapshot, excluded: ['tabletop-collection'] });
  assert.deepEqual(assessment.changedFiles, ['docs/versions/v1-execution-plan-review.md', 'docs/versions/v1.md']);
  state.decisions.push({ id: 'implementation-plan-source-compatible', actor: 'user', decision: 'approved',
    projectId: plan.projectId, runId: plan.runId, planDigest: plan.planDigest, artifactDigest: plan.artifactDigest,
    fromSourceDigest: assessment.fromSourceDigest, toSourceDigest: assessment.toSourceDigest,
    changedFilesDigest: assessment.changedFilesDigest });
  assert.equal(planSourceCompatibilitySatisfied(state, assessment), true);
  const changedEngine = { ...currentSnapshot, files: currentSnapshot.files.map(file => file.path.endsWith('lib.rs') ? { ...file, sha256: '6' } : file) };
  assert.equal(planSourceCompatibilitySatisfied(state, assessPlanSourceCompatibility({ planRun: state, baselineSnapshot, currentSnapshot: changedEngine, excluded: ['tabletop-collection'] })), false);
});

test('implementation Run uses the matching audited plan delta and rejects a later source edit', async t => {
  const fixture = await makeFixture({ profiles: ['engine-delivery'] });
  t.after(() => fixture.cleanup());
  const projectId = fixture.projectId;
  const planRunId = 'plan-v1';
  const profileConfig = { requireCanonicalDecision: false, requireUserCodeReview: false };
  const planMetadata = { commandIntent: { action: 'plan', target: 'V1' }, workflow: { id: 'engine-delivery' } };
  const started = await fixture.harness.startRun({ projectId, runId: planRunId, profileId: 'engine-delivery',
    features: [feature('planner', { stage: 'version-planning' }), feature('reviewer', { stage: 'plan-review' })],
    profileConfig, metadata: planMetadata, executionAuthorizationEvidence: { explicitUnattended: true } }, command());
  const baseline = await captureWorkspace(fixture.workspace);
  const snapshotEvidence = await fixture.harness.evidenceStore.put(baseline, { projectId, runId: planRunId, epoch: 1, generation: 1, sourceDigest: baseline.digest });
  const reviewed = await fixture.harness.authorityStore.transact(projectId, planRunId,
    { expectedRevision: started.state.revision, commandId: 'test-complete-plan', payload: {} }, state => {
      state.features.forEach(item => { item.state = 'completed'; });
      state.submissions = [
        { featureId: 'planner', result: { status: 'completed', outputs: { plan: { value: { proposedFeatures: [{ id: 'engine', projectId, disposition: 'project-owned', allowedPaths: ['src'], dependsOn: [] }] } } } } },
        { featureId: 'reviewer', result: { status: 'completed', outputs: { 'plan-review': { value: { approved: true, findings: [] } } } } },
      ];
      state.dispatches = [{ featureId: 'reviewer', sourceDigest: baseline.digest, sourceSnapshotRef: snapshotEvidence.ref }];
      state.status = 'closed';
    });
  const plan = planApprovalSnapshot(reviewed.state);
  await mkdir(join(fixture.workspace, 'docs'), { recursive: true });
  await writeFile(join(fixture.workspace, 'docs', 'review.md'), 'Reviewed plan publication\n');
  const current = await captureWorkspace(fixture.workspace);
  const assessment = assessPlanSourceCompatibility({ planRun: reviewed.state, baselineSnapshot: baseline, currentSnapshot: current });
  const decisions = [
    { id: 'implementation-plan-approved', actor: 'user', decision: 'approved', projectId, runId: planRunId, planDigest: plan.planDigest, artifactDigest: plan.artifactDigest },
    { id: 'implementation-plan-source-compatible', actor: 'reviewer', decision: 'approved', ...assessment },
  ];
  await fixture.harness.authorityStore.transact(projectId, planRunId,
    { expectedRevision: reviewed.state.revision, commandId: 'test-approve-plan', payload: {} }, state => { state.decisions.push(...decisions); });
  const implementation = feature('engine-implementation', { stage: 'implementation' });
  const implementInput = runId => ({ projectId, runId, profileId: 'engine-delivery', features: [implementation], profileConfig,
    metadata: { commandIntent: { action: 'implement', target: 'V1' }, workflow: { id: 'engine-delivery' } },
    executionAuthorizationEvidence: { explicitUnattended: true } });
  const accepted = await fixture.harness.startRun(implementInput('implement-v1'), command());
  assert.equal(accepted.state.metadata.approvedPlan.sourceCompatibility.changedFilesDigest, assessment.changedFilesDigest);
  await writeFile(join(fixture.workspace, 'engine-change.rs'), 'new engine source\n');
  await assert.rejects(() => fixture.harness.startRun(implementInput('implement-v1-later'), command()),
    error => error.code === 'IMPLEMENTATION_PLAN_SOURCE_MISMATCH');
});
