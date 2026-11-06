import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { digestJson, withoutKeys } from '../src/common/canonical.mjs';
import { amendmentReviewRecoveryIntent, createAmendmentReviewRecoveryPlan, interruptedAmendmentReviewDraft, interruptedAmendmentTransportDraft } from '../src/application/development-amendment-review-recovery.mjs';
import { selectAmendmentRetry } from '../src/application/plan-amendment-retry.mjs';
import { assertPlanningReplacementScope } from '../src/application/development-planning-recovery.mjs';
import { planApprovalSnapshot } from '../src/flows/delivery-lifecycle/plan-approval.mjs';
import { deriveQualityTargetSnapshot } from '../src/platform/execution/quality-target.mjs';
import { feature } from './test-support.mjs';

const fixture = () => {
  const snapshot = { protocolVersion: '1.0', root: resolve('.tmp/project'),
    files: [{ path: 'docs/draft/amendment.json', sha256: 'a'.repeat(64), size: 10 }] };
  snapshot.digest = digestJson(snapshot.files);
  const request = { target: 'V1', amendmentScope: { artifactRoot: 'docs/draft' } };
  const revision = { parentRunId: 'base', parentPlanDigest: 'b'.repeat(64), changeRequestDigest: digestJson(request),
    amendmentScope: request.amendmentScope, implementationBaselines: [{ runId: 'implementation', retirementChain: ['earlier-draft'] }] };
  const intent = { action: 'amend', target: 'V1', selector: 'boundary', profileId: 'delivery', workflowId: 'delivery',
    preset: 'change', requestedPreset: 'change:boundary', argumentPrefix: 'change:', changeRequest: request, planRevision: revision };
  const planner = { submissionId: 'submission', featureId: 'plan', dispatchId: 'dispatch', inputSourceDigest: 'c'.repeat(64),
    outputSourceDigest: snapshot.digest, evidenceRefs: ['evidence'], changedFiles: ['docs/draft/amendment.json'],
    result: { status: 'completed', outputs: { amendment: { value: { version: 'plan-amendment/1',
      basePlanDigest: revision.parentPlanDigest, changeRequestDigest: revision.changeRequestDigest,
      deltaRef: { path: 'docs/draft/amendment.json', sha256: 'a'.repeat(64) } } } } } };
  planner.submissionDigest = digestJson(planner);
  const state = { projectId: 'project', runId: 'interrupted', status: 'running', sourceDigest: snapshot.digest,
    artifactDigest: 'd'.repeat(64), metadata: { commandIntent: intent, planRevision: revision,
      workspace: { root: snapshot.root }, logicalTaskKey: 'logical', stopCondition: { action: 'approval' } },
    features: [
      { id: 'plan', state: 'completed', submissionId: 'submission', metadata: { stage: 'version-planning' },
        allowedPaths: ['docs'], forbiddenPaths: [], dependsOn: [], logicalRoot: 'plan' },
      { id: 'review', state: 'running', metadata: { stage: 'plan-review' }, allowedPaths: [], forbiddenPaths: [],
        dependsOn: ['plan'], logicalRoot: 'review' }],
    dispatches: [{ dispatchId: 'dispatch', status: 'committed', submissionId: 'submission' },
      { dispatchId: 'review-dispatch', featureId: 'review', status: 'assigned' }],
    leases: [{ featureId: 'review', dispatchId: 'review-dispatch', status: 'active' }], submissions: [planner], findings: [], decisions: [] };
  return { state, snapshot, project: { id: 'project', descriptorDigest: 'f'.repeat(64), policy: { planChangeRequests: { boundary: request } } },
    patchReceiptDigest: 'e'.repeat(64) };
};

test('review recovery preserves committed draft and baseline ancestry without transferring approval', () => {
  const input = fixture(), saved = structuredClone(input);
  const intent = amendmentReviewRecoveryIntent(input);
  assert.equal(intent.planRevision.recoveryDraft.acceptance, 'unaccepted-requires-planning-and-review');
  assert.deepEqual(intent.planRevision.recoveryDraft.deltaRef, input.state.submissions[0].result.outputs.amendment.value.deltaRef);
  assert.deepEqual(intent.planRevision.implementationBaselines[0].retirementChain, ['earlier-draft', 'interrupted']);
  assert.deepEqual(input, saved);
  const plan = { intent, project: input.project, logicalTaskKey: 'logical', stopCondition: input.state.metadata.stopCondition,
    run: { sourceDigest: input.snapshot.digest, executionWorkspaceRoot: input.snapshot.root,
      features: input.state.features.map(row => ({ ...row, state: 'pending' })) } };
  assertPlanningReplacementScope({ retired: input.state, plan, project: input.project, before: input.snapshot, after: input.snapshot });
  const retired = structuredClone(input.state);
  retired.status = 'superseded'; retired.metadata.supersededReason = `development-h3-recovery:${input.patchReceiptDigest}`;
  retired.leases[0].status = 'superseded'; retired.dispatches[1].status = 'superseded';
  assert.deepEqual(amendmentReviewRecoveryIntent({ ...input, state: retired }), intent);
});

test('review recovery rejects changed source, scope, evidence, writes, approval and completed review', () => {
  const mutations = [
    x => { x.snapshot.files[0].sha256 = '0'.repeat(64); },
    x => { x.project.policy.planChangeRequests.boundary.target = 'V2'; },
    x => { x.state.submissions[0].outputSourceDigest = '0'.repeat(64); },
    x => { x.state.submissions[0].evidenceRefs = []; },
    x => { x.state.submissions[0].submissionDigest = '0'.repeat(64); },
    x => { x.state.features[1].allowedPaths = ['src']; },
    x => { x.state.features[1].state = 'completed'; },
    x => { x.state.submissions.push({ featureId: 'review', result: { status: 'completed' } }); },
    x => { x.state.decisions.push({ id: 'implementation-plan-approved', decision: 'approved' }); },
    x => { x.state.findings.push({ status: 'open' }); },
    x => { x.state.leases[0].status = 'completed'; },
    x => { x.state.dispatches[1].status = 'committed'; },
    x => { x.state.status = 'failed'; },
    x => { x.patchReceiptDigest = 'invalid'; },
  ];
  for (const mutate of mutations) {
    const input = fixture(); mutate(input);
    assert.throws(() => amendmentReviewRecoveryIntent(input), { code: 'DEVELOPMENT_AMENDMENT_REVIEW_RECOVERY_UNSAFE' });
  }
});

test('ordinary amendment retry still cannot supersede a running review', () => {
  const input = fixture();
  assert.ok(interruptedAmendmentReviewDraft(input.state));
  assert.throws(() => selectAmendmentRetry({ states: [input.state], intent: input.state.metadata.commandIntent,
    parentRunId: 'base', parentPlanDigest: 'b'.repeat(64), request: input.project.policy.planChangeRequests.boundary,
    scope: input.state.metadata.planRevision.amendmentScope, artifactDigest: 'f'.repeat(64) }), { code: 'PLAN_AMENDMENT_RETRY_UNSAFE' });
});

test('an input-only failure preserves the original draft through another patched transport', () => {
  const input = fixture(), { state } = input;
  const saved = amendmentReviewRecoveryIntent(input).planRevision.recoveryDraft;
  state.runId = 'replacement'; state.status = 'ready';
  state.features[0].state = 'blocked'; delete state.features[0].submissionId;
  state.features[1].state = 'pending'; state.leases = [];
  state.dispatches = [{ dispatchId: 'input', status: 'committed', submissionId: 'blocked-input' }];
  const blocked = { submissionId: 'blocked-input', featureId: 'plan', dispatchId: 'input',
    inputSourceDigest: state.sourceDigest, outputSourceDigest: state.sourceDigest,
    changedFiles: [], evidenceRefs: ['observed-input-failure'], result: { status: 'blocked', blocker: { kind: 'input' } } };
  blocked.submissionDigest = digestJson(blocked); state.submissions = [blocked];
  state.metadata.planRevision.recoveryDraft = saved;
  state.metadata.planRevision.implementationBaselines[0].retirementChain.push('interrupted');
  assert.ok(interruptedAmendmentTransportDraft(state));
  const intent = amendmentReviewRecoveryIntent(input);
  assert.equal(intent.planRevision.recoveryDraft.priorRunId, 'interrupted');
  assert.equal(intent.planRevision.recoveryDraft.retiredRunId, 'replacement');
  assert.deepEqual(intent.planRevision.implementationBaselines[0].retirementChain, ['earlier-draft', 'interrupted', 'replacement']);
  const before = structuredClone(input);
  state.submissions[0].changedFiles.push('src/changed.mjs');
  assert.equal(interruptedAmendmentTransportDraft(state), null);
  Object.assign(state, before.state); state.submissions[0].outputSourceDigest = '0'.repeat(64);
  assert.equal(interruptedAmendmentTransportDraft(state), null);
});

test('replacement compiles against current source and reconstructs identically after retirement', async () => {
  const input = fixture(), { state, project, snapshot } = input;
  const base = { projectId: project.id, runId: 'base', status: 'closed', revision: 1, authorityDigest: '1'.repeat(64),
    sourceDigest: 'c'.repeat(64), createdAt: '2026-01-01T00:00:00Z',
    metadata: { commandIntent: { action: 'plan', target: 'V1', workflowId: 'delivery' } },
    features: ['version-planning', 'plan-review'].map((stage, i) => ({ id: `base-${i}`, state: 'completed', metadata: { stage } })),
    submissions: [{ featureId: 'base-0', result: { status: 'completed', outputs: { plan: { value: { proposedFeatures: [] } } } } },
      { featureId: 'base-1', result: { status: 'completed', outputs: { 'plan-review': { value: { approved: true, findings: [] } } } } }], decisions: [], findings: [] };
  const approval = planApprovalSnapshot(base);
  base.decisions.push({ id: 'implementation-plan-approved', decision: 'approved', actor: 'human', projectId: project.id,
    runId: base.runId, planDigest: approval.planDigest, artifactDigest: approval.artifactDigest });
  Object.assign(state.metadata.planRevision, { parentAuthorityDigest: base.authorityDigest, parentPlanDigest: approval.planDigest });
  const scope = state.metadata.planRevision.amendmentScope;
  Object.assign(scope, { version: 'plan-amendment/1', featureIds: ['A1'], planPointers: ['/proposedFeatures/0/contracts'], documents: [] });
  state.metadata.planRevision.changeRequestDigest = digestJson(project.policy.planChangeRequests.boundary);
  const planner = state.submissions[0];
  planner.result.outputs.amendment.value.basePlanDigest = approval.planDigest;
  planner.result.outputs.amendment.value.changeRequestDigest = state.metadata.planRevision.changeRequestDigest;
  planner.submissionDigest = digestJson(withoutKeys(planner, ['submissionDigest']));
  state.metadata.commandIntent.qualityTarget = deriveQualityTargetSnapshot({ projectId: project.id,
    workflowId: 'delivery', target: 'V1', sourceDigest: base.sourceDigest, runs: [] });
  Object.assign(project, { revision: 1, policy: { ...project.policy, agentExecutionMode: 'conversation-visible',
    defaultRuntimePlugin: 'native', runtimePlugins: ['native'] } });
  const workflow = { id: 'delivery', version: '1.0.0', artifactDigest: '2'.repeat(64) };
  const extension = { id: 'delivery', version: '1.0.0', digest: '3'.repeat(64), commandManifest: { id: 'delivery' }, workflows: [workflow],
    operations: { createLifecyclePlan: ({ intent }) => ({ run: { profileId: 'delivery',
      features: [feature('plan', { stage: 'version-planning' }, { allowedPaths: ['docs'] }),
        feature('review', { stage: 'plan-review' }, { allowedPaths: [], dependsOn: ['plan'] })],
      metadata: { workflow, qualityTarget: intent.qualityTarget } } }) } };
  const context = { ...input, authorityStore: { read: async () => base, list: async () => [base, state] }, extension,
    releaseIdentity: { version: '1.0.0', artifactDigest: '4'.repeat(64), verified: true }, executionConstraintDigest: '5'.repeat(64) };
  const plan = await createAmendmentReviewRecoveryPlan(context);
  assert.equal(plan.intent.qualityTarget.sourceDigest, snapshot.digest);
  assert.deepEqual(plan.run.features.map(row => row.id), ['plan', 'review']);
  assert.ok(plan.run.features.every(row => !row.submissionId));
  state.status = 'superseded';
  Object.assign(state.metadata, { supersededReason: `development-h3-recovery:${input.patchReceiptDigest}`,
    supersededByRunId: plan.run.runId, supersedePlanDigest: plan.planDigest });
  state.leases[0].status = 'superseded'; state.dispatches[1].status = 'superseded';
  assert.deepEqual(await createAmendmentReviewRecoveryPlan(context), plan);
  context.releaseIdentity.artifactDigest = '6'.repeat(64);
  await assert.rejects(createAmendmentReviewRecoveryPlan(context), { code: 'DEVELOPMENT_AMENDMENT_REVIEW_PLAN_STALE' });
});
