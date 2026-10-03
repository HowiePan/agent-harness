import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliveryLifecycleProfile } from '../src/flows/delivery-lifecycle/policy/delivery-lifecycle.mjs';
import { ensurePlanApprovalArtifact, planApprovalSatisfied, planApprovalSnapshot } from '../src/flows/delivery-lifecycle/plan-approval.mjs';
import { assessAutomaticPlanSourceCompatibility, assessPlanSourceCompatibility, assessRecoveredImplementationContinuation, assessVerifiedImplementationContinuation, planSourceCompatibilityDecisionId, planSourceCompatibilitySatisfied } from '../src/application/plan-source-compatibility.mjs';
import { assertCurrentPlanLineage, assertReviewedSourceDecision } from '../src/application/development-plan-source-compatibility.mjs';
import { captureWorkspace } from '../src/common/workspace-snapshot.mjs';
import { buildDispatchPacket } from '../src/kernel/kernel.mjs';
import { implementNode } from '../src/flows/delivery-lifecycle/nodes/implement/index.mjs';
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

test('operator source review binds the exact approved plan, changed paths, and current digest', () => {
  const state = reviewedRun(true);
  const plan = planApprovalSnapshot(state);
  const assessment = {
    projectId: plan.projectId, runId: plan.runId, planDigest: plan.planDigest, artifactDigest: plan.artifactDigest,
    fromSourceDigest: state.sourceDigest, toSourceDigest: 'b'.repeat(64),
    changedFiles: ['README.md'], changedFilesDigest: 'c'.repeat(64),
  };
  const decision = { id: planSourceCompatibilityDecisionId(assessment), actor: 'operator', decision: 'approved',
    ...assessment, reason: 'Reviewed status-only documentation drift against the approved plan and current project state.' };
  assert.doesNotThrow(() => assertReviewedSourceDecision({ planRun: state, assessment, decision }));
  state.decisions.push({ ...decision, id: 'implementation-plan-source-compatible', toSourceDigest: 'd'.repeat(64) }, decision);
  assert.equal(planSourceCompatibilitySatisfied(state, assessment), true);
  assert.equal(planSourceCompatibilitySatisfied(state, { ...assessment, toSourceDigest: 'e'.repeat(64) }), false);
  assert.throws(() => assertReviewedSourceDecision({ planRun: state, assessment,
    decision: { ...decision, toSourceDigest: 'd'.repeat(64) } }), error => error.code === 'PLAN_SOURCE_OPERATOR_REVIEW_STALE');
  assert.throws(() => assertReviewedSourceDecision({ planRun: state, assessment,
    decision: { ...decision, changedFiles: ['src/hidden.rs'] } }), error => error.code === 'PLAN_SOURCE_OPERATOR_REVIEW_STALE');
  assert.throws(() => assertReviewedSourceDecision({ planRun: state, assessment,
    decision: { ...decision, actor: 'user' } }), error => error.code === 'PLAN_SOURCE_OPERATOR_REVIEW_REQUIRED');
});

test('operator source review targets the active plan revision', () => {
  const planRun = { runId: 'replan-2', metadata: { logicalTaskKey: 'plan:V2' } };
  assert.doesNotThrow(() => assertCurrentPlanLineage({ planRun, lineage: { activeRunId: 'replan-2' } }));
  assert.throws(() => assertCurrentPlanLineage({ planRun, lineage: { activeRunId: 'plan-1' } }),
    error => error.code === 'PLAN_SOURCE_ACTIVE_REVISION_REQUIRED');
});

test('automatic plan source compatibility requires policy, approved project scope, and implementation scope', () => {
  const state = reviewedRun(true);
  state.submissions[0].result.outputs.plan.value.proposedFeatures = [
    { id: 'engine', projectId: 'sample', disposition: 'project-owned', allowedPaths: ['scripts/cardworld.ps1'] },
    { id: 'collection', projectId: 'other', disposition: 'cross-project-dependency', allowedPaths: ['other-project'] },
  ];
  const base = { digest: state.sourceDigest, files: [
    { path: 'scripts/cardworld.ps1', sha256: '1', size: 1 },
    { path: 'other-project/script.ps1', sha256: '2', size: 1 },
  ] };
  const current = { digest: 'b'.repeat(64), files: base.files.map(file => file.path === 'scripts/cardworld.ps1'
    ? { ...file, sha256: '3' } : file) };
  const assessment = assessPlanSourceCompatibility({ planRun: state, baselineSnapshot: base, currentSnapshot: current });
  const input = { planRun: state, assessment, implementationFeatures: [{ metadata: { stage: 'implementation', sourcePolicy: 'write' }, allowedPaths: ['scripts'] }],
    policyPaths: ['scripts/cardworld.ps1'] };
  assert.deepEqual(assessAutomaticPlanSourceCompatibility(input)?.changedFiles, ['scripts/cardworld.ps1']);
  assert.equal(assessAutomaticPlanSourceCompatibility({ ...input, policyPaths: [] }), null);
  assert.equal(assessAutomaticPlanSourceCompatibility({ ...input, implementationFeatures: [{ metadata: { stage: 'implementation' }, allowedPaths: ['src'] }] }), null);
  const outsidePlan = { ...assessment, changedFiles: ['other-project/script.ps1'] };
  assert.equal(assessAutomaticPlanSourceCompatibility({ ...input, assessment: outsidePlan, policyPaths: ['other-project'] }), null);
  assert.throws(() => assessAutomaticPlanSourceCompatibility({ ...input, policyPaths: ['../scripts'] }), error => error.code === 'PLAN_SOURCE_AUTO_PATH_INVALID');
});

test('a verified prior implementation submission carries the same approved plan forward without admitting unrelated drift', () => {
  const planRun = reviewedRun(true);
  const artifact = planApprovalSnapshot(planRun);
  const before = 'b'.repeat(64);
  const after = 'c'.repeat(64);
  const priorRun = {
    projectId: planRun.projectId, runId: 'implement-prior', sourceDigest: after,
    metadata: { commandIntent: { action: 'implement', target: 'V1' }, workspace: { root: process.cwd() },
      approvedPlan: { runId: planRun.runId, planDigest: artifact.planDigest, artifactDigest: artifact.artifactDigest,
        originalSourceDigest: planRun.sourceDigest, sourceDigest: before, sourceCompatibility: { mode: 'reviewed-decision' } } },
    features: [{ id: 'implement/V1', allowedPaths: ['scripts'] }], leases: [], dispatches: [],
    submissions: [{ featureId: 'implement/V1', inputSourceDigest: before, outputSourceDigest: after,
      changedFiles: ['scripts/check.ps1'], evidenceRefs: ['sha256:verified'], submissionDigest: 'submission-1' }],
  };
  const input = { planRun, planArtifact: artifact, priorRuns: [priorRun], currentSourceDigest: after,
    workspaceRoot: process.cwd(), implementationFeatures: [{ metadata: { stage: 'implementation' }, allowedPaths: ['scripts'] }] };
  assert.deepEqual(assessVerifiedImplementationContinuation(input), {
    mode: 'verified-prior-implementation', priorRunId: priorRun.runId, fromSourceDigest: before,
    toSourceDigest: after, submissionDigests: ['submission-1'],
  });
  assert.equal(assessVerifiedImplementationContinuation({ ...input, currentSourceDigest: 'd'.repeat(64) }), null);
  assert.equal(assessVerifiedImplementationContinuation({ ...input, priorRuns: [{ ...priorRun,
    metadata: { ...priorRun.metadata, approvedPlan: { ...priorRun.metadata.approvedPlan, planDigest: 'wrong-plan' } } }] }), null);
  assert.equal(assessVerifiedImplementationContinuation({ ...input, priorRuns: [{ ...priorRun,
    submissions: [{ ...priorRun.submissions[0], changedFiles: ['outside/check.ps1'] }] }] }), null);
  assert.equal(assessVerifiedImplementationContinuation({ ...input, priorRuns: [{ ...priorRun,
    leases: [{ status: 'active' }] }] }), null);
});

test('recovery carries only a fenced abandoned Dispatch delta as unverified implementation input', async () => {
  const planRun = reviewedRun(true);
  planRun.submissions[0].result.outputs.plan.value.proposedFeatures[0].allowedPaths = ['src/first.rs'];
  planRun.metadata.workflow = { id: 'engine-delivery' };
  const artifact = planApprovalSnapshot(planRun);
  const before = 'b'.repeat(64);
  const submitted = 'c'.repeat(64);
  const current = 'd'.repeat(64);
  const priorRun = {
    projectId: planRun.projectId, runId: 'implement-abandoned', status: 'superseded', sourceDigest: submitted,
    metadata: { commandIntent: { action: 'implement', target: 'V1' }, workflow: { id: 'engine-delivery' },
      workspace: { root: process.cwd() }, supersededReason: `development-h3-recovery:${'f'.repeat(64)}`,
      approvedPlan: { runId: planRun.runId, planDigest: artifact.planDigest, artifactDigest: artifact.artifactDigest,
        originalSourceDigest: planRun.sourceDigest, sourceDigest: before } },
    features: [{ id: 'implement/V1', metadata: { stage: 'implementation' }, allowedPaths: ['src'] }],
    submissions: [{ featureId: 'implement/V1', dispatchId: 'submitted', inputSourceDigest: before,
      outputSourceDigest: submitted, changedFiles: ['src/first.rs'], evidenceRefs: ['verified'], submissionDigest: 'submission-1' }],
    dispatches: [{ dispatchId: 'abandoned', featureId: 'implement/V1', status: 'superseded',
      sourceDigest: submitted, sourceSnapshotRef: 'evidence:snapshot', packetDigest: 'p'.repeat(64) }],
    leases: [{ dispatchId: 'abandoned', status: 'superseded', agentId: 'agent', runtimeReceipt: {
      prompt: { promptDigest: 'q'.repeat(64) }, hostSpawnReceipt: { effectId: 'effect', contract: { id: 'native' } },
    } }],
  };
  const effect = { state: 'contained', effectDigest: 'e'.repeat(64), canonicalAgentName: 'agent',
    outcome: { reason: 'development-run-recovery', disposition: 'absent-after-interrupt' },
    binding: { projectId: planRun.projectId, runId: priorRun.runId, dispatchId: 'abandoned',
      packetDigest: 'p'.repeat(64), promptDigest: 'q'.repeat(64) } };
  const baseline = { digest: submitted, files: [{ path: 'src/first.rs', sha256: '1', size: 1 }] };
  const currentSnapshot = { digest: current, files: [...baseline.files, { path: 'src/second.rs', sha256: '2', size: 1 }] };
  const input = { planRun, planArtifact: artifact, priorRuns: [priorRun], currentSnapshot, workspaceRoot: process.cwd(),
    implementationFeatures: [{ metadata: { stage: 'implementation' }, allowedPaths: ['src'] }],
    evidenceStore: { read: async () => ({ metadata: { projectId: planRun.projectId, runId: priorRun.runId },
      bytes: Buffer.from(JSON.stringify(baseline)) }) }, readHostEffect: async () => effect };
  const accepted = await assessRecoveredImplementationContinuation(input);
  assert.equal(accepted.mode, 'verified-prior-implementation-with-abandoned-dispatch');
  assert.deepEqual(accepted.changedFiles, ['src/second.rs']);
  assert.deepEqual(accepted.submissionDigests, ['submission-1']);
  assert.equal(await assessRecoveredImplementationContinuation({ ...input, currentSnapshot: {
    digest: current, files: [...baseline.files, { path: 'README.md', sha256: '2', size: 1 }],
  } }), null);
  assert.equal(await assessRecoveredImplementationContinuation({ ...input, readHostEffect: async () => ({ ...effect,
    outcome: { reason: 'preflight-reconciliation', disposition: 'not-observed' },
  }) }), null);
});

test('implementation accepts only a source delta covered by the approved plan and project policy', async t => {
  const fixture = await makeFixture({ profiles: ['engine-delivery'], policy: { planSourceAutoCompatiblePaths: ['scripts/check.ps1'] } });
  t.after(() => fixture.cleanup());
  const projectId = fixture.projectId;
  const planRunId = 'plan-auto';
  const started = await fixture.harness.startRun({ projectId, runId: planRunId, profileId: 'engine-delivery',
    features: [feature('planner', { stage: 'version-planning' }), feature('reviewer', { stage: 'plan-review' })],
    profileConfig: { requireCanonicalDecision: false, requireUserCodeReview: false },
    metadata: { commandIntent: { action: 'plan', target: 'V2' }, workflow: { id: 'engine-delivery' } },
    executionAuthorizationEvidence: { explicitUnattended: true } }, command());
  const baseline = await captureWorkspace(fixture.workspace);
  const evidence = await fixture.harness.evidenceStore.put(baseline, { projectId, runId: planRunId, epoch: 1, generation: 1, sourceDigest: baseline.digest });
  const reviewed = await fixture.harness.authorityStore.transact(projectId, planRunId,
    { expectedRevision: started.state.revision, commandId: 'test-auto-plan', payload: {} }, state => {
      state.features.forEach(item => { item.state = 'completed'; });
      state.submissions = [
        { featureId: 'planner', result: { status: 'completed', outputs: { plan: { value: { proposedFeatures: [
          { id: 'script', projectId, disposition: 'project-owned', allowedPaths: ['scripts/check.ps1'], dependsOn: [] },
        ] } } } } },
        { featureId: 'reviewer', result: { status: 'completed', outputs: { 'plan-review': { value: { approved: true, findings: [] } } } } },
      ];
      state.dispatches = [{ featureId: 'reviewer', sourceDigest: baseline.digest, sourceSnapshotRef: evidence.ref }];
      state.status = 'closed';
    });
  const approval = planApprovalSnapshot(reviewed.state);
  await fixture.harness.authorityStore.transact(projectId, planRunId,
    { expectedRevision: reviewed.state.revision, commandId: 'test-auto-approve', payload: {} }, state => {
      state.decisions.push({ id: 'implementation-plan-approved', actor: 'user', decision: 'approved',
        projectId, runId: planRunId, planDigest: approval.planDigest, artifactDigest: approval.artifactDigest });
    });
  await mkdir(join(fixture.workspace, 'scripts'), { recursive: true });
  await writeFile(join(fixture.workspace, 'scripts', 'check.ps1'), 'Write-Output ok\n');
  const input = { projectId, runId: 'implement-auto', profileId: 'engine-delivery',
    features: [feature('engine', { stage: 'implementation' }, { allowedPaths: ['scripts'] })],
    profileConfig: { requireCanonicalDecision: false, requireUserCodeReview: false },
    metadata: { commandIntent: { action: 'implement', target: 'V2' }, workflow: { id: 'engine-delivery' } },
    executionAuthorizationEvidence: { explicitUnattended: true } };
  const accepted = await fixture.harness.startRun(input, command());
  assert.equal(accepted.state.metadata.approvedPlan.sourceCompatibility.mode, 'approved-plan-policy-paths');
  assert.deepEqual(accepted.state.metadata.approvedPlan.sourceCompatibility.changedFiles, ['scripts/check.ps1']);
  assert.equal(accepted.state.metadata.approvedPlan.typedPlan.proposedFeatures[0].id, 'script');
  assert.equal(accepted.state.features[0].metadata.implementationProgressRetries, 20);
  assert.equal(accepted.state.features[0].attemptLimit, 21);
  const taskFeature = { ...implementNode, id: 'implement/V2', metadata: accepted.state.features[0].metadata, dependsOn: [] };
  const packet = buildDispatchPacket(accepted.state, { dispatchId: 'dispatch-plan-input', outputRef: 'output-ref' }, taskFeature);
  assert.deepEqual(packet.workflowContext.taskInputs.find(binding => binding.id === 'approved-delivery-plan').value,
    accepted.state.metadata.approvedPlan.typedPlan);
  const withoutPlan = { ...accepted.state, metadata: { ...accepted.state.metadata, approvedPlan: null } };
  const missingPlanFeature = { ...taskFeature, metadata: { stage: 'implementation' } };
  const missingPacket = buildDispatchPacket(withoutPlan, { dispatchId: 'dispatch-no-plan', outputRef: 'output-ref' }, missingPlanFeature);
  assert.equal(missingPacket.workflowContext.taskInputs.find(binding => binding.id === 'approved-delivery-plan').value, null);
  const upstreamState = {
    ...withoutPlan,
    features: [...accepted.state.features, { id: 'plan-feature', metadata: { workflow: { nodeId: 'plan' } } }],
    submissions: [...accepted.state.submissions, { featureId: 'plan-feature', result: { outputs: { plan: { schemaId: 'delivery-plan-v1', value: accepted.state.metadata.approvedPlan.typedPlan } } } }],
  };
  const upstreamPacket = buildDispatchPacket(upstreamState, { dispatchId: 'dispatch-upstream-plan', outputRef: 'output-ref' }, { ...missingPlanFeature, dependsOn: ['plan-feature'] });
  assert.equal(upstreamPacket.workflowContext.taskInputs.find(binding => binding.id === 'upstream-delivery-plan').values[0].value.proposedFeatures[0].id, 'script');
  await writeFile(join(fixture.workspace, 'README.md'), '# Changed after approval\n');
  await assert.rejects(() => fixture.harness.startRun({ ...input, runId: 'implement-auto-later' }, command()),
    error => error.code === 'IMPLEMENTATION_PLAN_SOURCE_MISMATCH');
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
  const priorFile = 'work/engine-implementation/progress.rs';
  await mkdir(join(fixture.workspace, 'work', 'engine-implementation'), { recursive: true });
  await writeFile(join(fixture.workspace, priorFile), 'verified prior progress\n');
  const progressed = await captureWorkspace(fixture.workspace);
  await fixture.harness.authorityStore.transact(projectId, 'implement-v1',
    { expectedRevision: accepted.state.revision, commandId: 'test-prior-progress', payload: {} }, state => {
      state.submissions.push({ featureId: 'engine-implementation', inputSourceDigest: current.digest,
        outputSourceDigest: progressed.digest, changedFiles: [priorFile], evidenceRefs: ['sha256:verified'],
        submissionDigest: 'verified-submission' });
      state.sourceDigest = progressed.digest;
      state.status = 'superseded';
    });
  const continued = await fixture.harness.startRun(implementInput('implement-v1-continued'), command());
  assert.equal(continued.state.metadata.approvedPlan.sourceCompatibility.mode, 'verified-prior-implementation');
  assert.equal(continued.state.metadata.approvedPlan.sourceCompatibility.priorRunId, 'implement-v1');
  await writeFile(join(fixture.workspace, 'engine-change.rs'), 'new engine source\n');
  await assert.rejects(() => fixture.harness.startRun(implementInput('implement-v1-later'), command()),
    error => error.code === 'IMPLEMENTATION_PLAN_SOURCE_MISMATCH');
});
