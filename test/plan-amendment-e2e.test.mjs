import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHarness, createInMemoryRuntime, loadExtensionPack, harnessTemporaryRoot } from '../src/index.mjs';
import { createDeliveryProjectDescriptor } from '../src/flows/delivery-lifecycle/descriptor.mjs';
import { projectExecutionPolicyDecisionContext } from '../src/platform/registry/project-registry.mjs';
import { planApprovalSnapshot, reviewedPlanProposal } from '../src/flows/delivery-lifecycle/plan-approval.mjs';
import { materializePlanAmendment, planAmendmentReference } from '../src/application/plan-amendment-artifacts.mjs';
import { digestJson } from '../src/common/canonical.mjs';
import { captureWorkspace, diffWorkspaceSnapshots } from '../src/common/workspace-snapshot.mjs';
import { createTestExecutionAuthorizationAdapter, createMockVisibleHostAdapter } from './test-support.mjs';
import { amendmentFixture } from './fixtures/plan-amendment.mjs';

for (const visible of [false, true]) test(`amend command reaches reviewed approval, closed receipt and selective implementation continuation (${visible ? 'native-visible' : 'headless'})`, async t => {
  const controlRoot = resolve(process.cwd());
  const root = await mkdtemp(resolve(harnessTemporaryRoot(), 'amendment-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = resolve(root, 'project');
  await mkdir(resolve(workspaceRoot, '.git'), { recursive: true });
  await mkdir(resolve(workspaceRoot, 'src'), { recursive: true });
  await writeFile(resolve(workspaceRoot, 'src/main.mjs'), 'export const stable = true;\n');
  const extension = await loadExtensionPack('./src/flows/delivery-lifecycle/index.mjs', { controlRoot });
  const codex = visible ? await loadExtensionPack('./integrations/codex/extensions/codex-runtime.mjs', { controlRoot }) : null;
  const packets = new Map();
  const adapter = visible ? createMockVisibleHostAdapter({
    onSpawn: input => packets.set(input.dispatchId, input.packet),
    onResult: input => handler(packets.get(input.dispatchId)),
    onReconcile: async () => ({ ready: true, provider: 'test-host', adapterVersion: '1.0.0',
      contract: { id: 'amendment-test-native', version: '1.0.0', digest: 'd'.repeat(64) },
      assertionId: 'amendment-test-reconciliation', observedAt: new Date().toISOString(), reconciled: [], issues: [] }),
  }) : null;
  const harnessOptions = { controlRoot, dataRoot: resolve(root, 'data'), strictProjectIdentity: false,
    releaseIdentity: { version: '1.0.0', artifactDigest: 'a'.repeat(64), verified: true },
    extensions: [extension, ...(codex ? [codex] : [])], agentAdapter: adapter,
    executionAuthorizationAdapter: createTestExecutionAuthorizationAdapter() };
  let harness = await createHarness(harnessOptions);
  const runtime = { id: 'amendment-memory-test', kind: 'agent-runtime', version: '1.0.0',
    capabilities: ['spawn', 'wait', 'send', 'heartbeat', 'interrupt', 'headless'], permissions: [] };
  const fixture = amendmentFixture();
  let amendmentReviews = 0;
  let scopeBlocked = 0;
  let formatBlocked = false;
  const handler = async packet => {
    const state = await harness.authorityStore.read(packet.projectId, packet.runId);
    const action = state.metadata.commandIntent.action;
    const stage = packet.feature.metadata.stage;
    const completed = (port, schemaId, value, changedFiles = []) => ({ status: 'completed', summary: 'Synthetic command contract verified', changedFiles,
      outputs: { [port]: { schemaId, value, evidenceRefs: ['fixture:source-inspection'] } } });
    if (action === 'plan' && stage === 'version-planning') return completed('plan', 'delivery-plan-v1', fixture.parentPlan);
    if (action === 'plan' && stage === 'plan-review') return completed('plan-review', 'delivery-plan-review-v1', { approved: true, findings: [] });
    if (action === 'amend' && stage === 'version-planning') {
      if (scopeBlocked < 2) {
        scopeBlocked += 1;
        const report = `docs/amend/scope-${scopeBlocked}.md`;
        await mkdir(resolve(workspaceRoot, 'docs/amend'), { recursive: true });
        await writeFile(resolve(workspaceRoot, report), `Frozen scope audit ${scopeBlocked}\n`);
        return { status: 'blocked', summary: 'A consumer lifetime pointer is missing from the registered scope',
          changedFiles: [report], failureClass: 'scope-blocker', blocker: { kind: 'scope', code: 'fixture-missing-scope',
            summary: 'Register the exact missing pointer before creating a replacement draft' } };
      }
      if (visible && amendmentReviews === 1 && packet.feature.metadata.planReviewRound > 1 && !formatBlocked) {
        formatBlocked = true;
        const path = 'docs/amend/format-draft.json';
        await writeFile(resolve(workspaceRoot, path), '{"preserved":"unaccepted corrected draft"}\n');
        return { status: 'blocked', summary: 'Corrected delta needs supported structural additions', changedFiles: [path],
          failureClass: 'protected-plan-blocker', blocker: { kind: 'protected', code: 'PLAN_AMENDMENT_TOO_LARGE',
            summary: 'The repeated preimages exceed the fixed delta bound' } };
      }
      const patch = { ...fixture.patch, basePlanDigest: state.metadata.planRevision.parentPlanDigest,
        changeRequestDigest: state.metadata.planRevision.changeRequestDigest };
      patch.changes = [{ path: '/proposedFeatures/1/contracts',
        expectedDigest: digestJson(state.metadata.planRevision.parentPlan.proposedFeatures[1].contracts),
        value: [`runtime and consumer boundary for ${state.metadata.planRevision.parentPlanDigest}`] }];
      if (packet.feature.metadata.planReviewRound > 1) patch.changes = [{ ...patch.changes[0],
        value: ['runtime and prerequisite consumer conversion with explicit source lifetime'] }];
      if (visible) patch.changes[0].value = patch.changes[0].value.map(value => `${value} ${'large-plan-contract '.repeat(16000)}`);
      const before = await captureWorkspace(workspaceRoot);
      const materialized = await materializePlanAmendment({ revision: state.metadata.planRevision, patch, workspaceRoot });
      const changedFiles = diffWorkspaceSnapshots(before, await captureWorkspace(workspaceRoot));
      return completed('amendment', 'delivery-plan-amendment-v1', planAmendmentReference(materialized), changedFiles);
    }
    if (action === 'amend' && stage === 'plan-review') {
      const plan = reviewedPlanProposal(state);
      amendmentReviews += 1;
      const value = completed('plan-review', 'delivery-plan-review-v1', { approved: amendmentReviews > 1,
        findings: amendmentReviews > 1 ? [] : ['PR-1 [P1] A1 requires an explicit consumer source-lifetime contract.'],
        resolvedFindings: state.findings.some(row => row.id === 'PR-1') ? ['PR-1'] : [],
        basePlanDigest: plan.amendment.basePlanDigest, deltaDigest: plan.amendment.deltaDigest,
        reviewedFeatureIds: ['A1', 'A2'] });
      value.findings = amendmentReviews === 1 ? [{ id: 'PR-1', severity: 'P1',
        summary: 'A1 requires an explicit consumer source-lifetime contract.', affectedPaths: ['docs/amend'], evidence: ['source lifetime'] }] : [];
      value.checkpoints = amendmentReviews === 2 ? [{ id: 'PR-1', status: 'resolved',
        summary: 'Verified the corrected producer and consumer source lifetime.', evidence: ['exact corrected amendment'] }] : [];
      return value;
    }
    if (action === 'implement' && stage === 'implementation') {
      const proposal = packet.feature.metadata.approvedProposal;
      if (proposal.id === 'A0') return completed('implement', 'delivery-implementation-v1', {
        changedFiles: [], proposalId: proposal.id, completedContracts: proposal.contracts, verificationResults: [] });
      await assert.rejects(create('amend', ['change:boundary']), { code: 'REPLAN_IMPLEMENTATION_BUSY' });
      return { status: 'blocked', summary: 'Synthetic consumer boundary requires reviewed amendment', changedFiles: [],
        failureClass: 'authority-blocker', blocker: { kind: 'authority', code: 'fixture-boundary', summary: 'Consumer retires after its input type' } };
    }
    throw new Error(`Unexpected synthetic stage ${action}/${stage}`);
  };
  if (!visible) harness.registerPlugin(runtime, createInMemoryRuntime({ manifest: runtime, handler }));
  const runtimeId = visible ? 'codex-conversation-runtime' : runtime.id;
  const descriptor = createDeliveryProjectDescriptor({ id: 'sample', workspaceRoot, runtimePluginId: runtimeId,
    runtimePluginIds: [runtimeId], ...(visible ? {} : { runtimeExtension: null }),
    agentExecutionMode: visible ? 'conversation-visible' : 'headless', gateRecipes: [],
    actionPaths: { plan: ['docs'], amend: ['docs'], implement: ['src', 'docs'] },
    planChangeRequests: { boundary: { target: 'V1.0.0', kind: 'dependency', summary: 'Resolve the runtime consumer boundary',
      requirements: ['Sequence retirement after consumer conversion'], acceptance: ['No live consumer loses its input type'],
      amendmentScope: fixture.revision.amendmentScope } } });
  descriptor.extensions[0].digest = extension.digest;
  if (visible) descriptor.extensions.find(item => item.id === codex.id).digest = codex.digest;
  descriptor.workflows = extension.workflows.map(item => ({ id: item.id, version: item.version, artifactDigest: item.artifactDigest, extensionId: extension.id }));
  await harness.projectRegistry.register(descriptor, { commandId: 'amendment-fixture-register', authorityDecision: {
    actor: 'test', decision: 'approved', action: 'project-execution-policy-change', expiresAt: '2099-01-01T00:00:00.000Z',
    context: projectExecutionPolicyDecisionContext({ input: descriptor }) } });
  const create = (action, args = []) => harness.createLifecyclePlan({ projectId: descriptor.id, action, target: 'V1.0.0',
    arguments: args, extensionId: extension.id, executionWorkspaceRoot: workspaceRoot,
    executionAuthorizationEvidence: { explicitUnattended: true } });
  const execute = async (plan, commandId) => {
    const preflightReport = await harness.createExecutionReadinessReport(plan);
    assert.equal(preflightReport.executionReady, true, JSON.stringify(preflightReport));
    return visible ? harness.executeVisibleLifecyclePlan(plan, { commandId, preflightReport, maxConcurrency: 1 })
      : harness.executeLifecyclePlan(plan, { commandId, preflightReport, maxConcurrency: 1 });
  };
  const approveAndClose = async state => {
    const snapshot = planApprovalSnapshot(state);
    const decision = { id: 'implementation-plan-approved', actor: 'user', decision: 'approved', projectId: state.projectId,
      runId: state.runId, planDigest: snapshot.planDigest, artifactDigest: snapshot.artifactDigest };
    const approved = await harness.kernel.recordDecision(state.projectId, state.runId, decision,
      { expectedRevision: state.revision, commandId: `approve-${state.runId}` });
    return harness.kernel.closeRun(state.projectId, state.runId, {},
      { expectedRevision: approved.state.revision, commandId: `close-${state.runId}` });
  };
  const original = await create('plan');
  const planned = await execute(original, 'initial-plan');
  assert.equal(planned.reason, 'implementation-plan-user-approval-required');
  await assert.rejects(create('amend', ['change:boundary']), { code: 'PLAN_AMENDMENT_APPROVED_BASE_REQUIRED' });
  await approveAndClose(planned.state);
  const implementation = await execute(await create('implement'), 'initial-implementation');
  assert.equal(implementation.state.features.find(item => item.metadata.approvedProposal?.id === 'A0').state, 'completed');
  const oldAttempts = structuredClone(implementation.state.attempts);
  const blockedDraft = await create('amend', ['change:boundary']);
  const blockedAmendment = await execute(blockedDraft, 'scope-blocked-amendment');
  assert.equal(blockedAmendment.state.features.find(item => item.metadata.stage === 'version-planning').state, 'blocked');
  const unchangedDraft = await create('amend', ['change:boundary']);
  assert.equal((await harness.createExecutionReadinessReport(unchangedDraft)).executionReady, false);
  descriptor.policy.planChangeRequests.boundary.amendmentScope.planPointers.push('/proposedFeatures/2/dependsOn');
  await harness.projectRegistry.register(descriptor, { expectedRevision: 1, commandId: 'correct-amendment-scope', authorityDecision: {
    actor: 'test', decision: 'approved', action: 'project-execution-policy-change', expiresAt: '2099-01-01T00:00:00.000Z',
    context: projectExecutionPolicyDecisionContext({ input: descriptor }) } });
  await writeFile(resolve(workspaceRoot, 'src/main.mjs'), 'export const unrelated = true;\n');
  await assert.rejects(create('amend', ['change:boundary']), { code: 'PLAN_AMENDMENT_BASELINE_SOURCE_CHANGED' });
  await writeFile(resolve(workspaceRoot, 'src/main.mjs'), 'export const stable = true;\n');
  await writeFile(resolve(workspaceRoot, 'docs/amend/scope-1.md'), 'Uncommitted replacement audit\n');
  await assert.rejects(create('amend', ['change:boundary']), { code: 'PLAN_AMENDMENT_DRAFT_ARTIFACT_CHANGED' });
  await writeFile(resolve(workspaceRoot, 'docs/amend/scope-1.md'), 'Frozen scope audit 1\n');
  await writeFile(resolve(workspaceRoot, 'docs/amend/unclaimed.md'), 'Unclaimed artifact\n');
  await assert.rejects(create('amend', ['change:boundary']), { code: 'PLAN_AMENDMENT_BASELINE_SOURCE_CHANGED' });
  await rm(resolve(workspaceRoot, 'docs/amend/unclaimed.md'));
  const secondBlockedDraft = await create('amend', ['change:boundary']);
  const secondBlockedAmendment = await execute(secondBlockedDraft, 'second-scope-blocked-amendment');
  assert.equal(secondBlockedAmendment.state.features.find(item => item.metadata.stage === 'version-planning').state, 'blocked');
  if (visible) {
    // A fresh verified Core after repair, with no fabricated scope change.
    const releaseIdentity = { version: '1.0.0', artifactDigest: 'b'.repeat(64), verified: true };
    harness = await createHarness({ ...harnessOptions, releaseIdentity });
    descriptor.harness = { version: releaseIdentity.version, artifactDigest: releaseIdentity.artifactDigest };
  } else descriptor.policy.planChangeRequests.boundary.amendmentScope.planPointers.push('/proposedFeatures/1/verification');
  await harness.projectRegistry.register(descriptor, { expectedRevision: 2, commandId: 'correct-second-amendment-scope', authorityDecision: {
    actor: 'test', decision: 'approved', action: 'project-execution-policy-change', expiresAt: '2099-01-01T00:00:00.000Z',
    context: projectExecutionPolicyDecisionContext({ input: descriptor }) } });
  const amendment = await create('amend', ['change:boundary']);
  assert.equal(amendment.intent.planRevision.replacesAmendment.runId, secondBlockedDraft.run.runId);
  if (visible) assert.equal(amendment.intent.planRevision.replacesAmendment.replacementArtifactDigest, 'b'.repeat(64));
  assert.deepEqual(amendment.intent.planRevision.implementationBaselines[0].retirementChain,
    [blockedDraft.run.runId, secondBlockedDraft.run.runId]);
  assert.equal(amendment.logicalTaskKey, original.logicalTaskKey);
  assert.deepEqual(amendment.run.features[0].allowedPaths, ['docs/amend']);
  assert.deepEqual(amendment.run.features[1].allowedPaths, []);
  let amended = await execute(amendment, 'amend-boundary');
  let reviewedAmendment = amendment;
  if (visible) {
    assert.equal(amended.reason, 'blocked-dependencies');
    const rejected = amended.state;
    assert.equal(rejected.findings[0].status, 'open');
    const originalAttempts = structuredClone(rejected.attempts);
    const releaseIdentity = { version: '1.0.0', artifactDigest: 'c'.repeat(64), verified: true };
    harness = await createHarness({ ...harnessOptions, releaseIdentity });
    descriptor.harness = { version: releaseIdentity.version, artifactDigest: releaseIdentity.artifactDigest };
    await harness.projectRegistry.register(descriptor, { expectedRevision: 3, commandId: 'repair-amendment-format', authorityDecision: {
      actor: 'test', decision: 'approved', action: 'project-execution-policy-change', expiresAt: '2099-01-01T00:00:00.000Z',
      context: projectExecutionPolicyDecisionContext({ input: descriptor }) } });
    const replacement = await create('amend', ['change:boundary']);
    const saved = replacement.intent.planRevision.replacesAmendment.preservedDraft;
    assert.equal(saved.rejectedReview.value.approved, false);
    assert.equal(saved.openFindings[0].id, 'PR-1');
    assert.deepEqual(saved.correctedDraft.changedFiles, ['docs/amend/format-draft.json']);
    assert.deepEqual(replacement.intent.planRevision.implementationBaselines[0].retirementChain,
      [blockedDraft.run.runId, secondBlockedDraft.run.runId, rejected.runId]);
    amended = await execute(replacement, 'amend-format-repaired');
    reviewedAmendment = replacement;
    const prior = await harness.authorityStore.read(descriptor.id, rejected.runId);
    assert.equal(prior.status, 'superseded');
    assert.deepEqual(prior.attempts, originalAttempts);
    assert.equal(prior.findings[0].status, 'open');
    assert.equal(amended.state.findings[0].status, 'resolved');
    assert.equal(amended.state.findings[0].resolution.originRunId, prior.runId);
    assert.equal(prior.submissions.find(row => row.result.outputs?.['plan-review']).result.outputs['plan-review'].value.approved, false);
  }
  const retiredDraft = await harness.authorityStore.read(descriptor.id, blockedDraft.run.runId);
  assert.equal(retiredDraft.status, 'superseded');
  assert.equal(retiredDraft.submissions.length, 1);
  assert.equal(retiredDraft.submissions[0].result.status, 'blocked');
  assert.equal(amended.reason, 'implementation-plan-user-approval-required');
  assert.equal(amendmentReviews, 2);
  const amendmentSubmission = amended.state.submissions.find(item => item.result.outputs?.amendment);
  const amendmentEvidence = JSON.parse((await harness.evidenceStore.read(amendmentSubmission.evidenceRefs[0])).bytes.toString('utf8'));
  assert(amendmentEvidence.nativeResult.outputs.amendment.value.deltaRef);
  assert.equal(amendmentEvidence.nativeResult.outputs.amendment.value.plan, undefined);
  assert.equal(amendmentEvidence.outputMaterialization.kind, 'plan-amendment-reference-resolution');
  assert.equal(amendmentSubmission.result.outputs.amendment.value.plan, undefined);
  assert(reviewedPlanProposal(amended.state).proposedFeatures.length);
  assert(Buffer.byteLength(JSON.stringify(amendmentSubmission.result.outputs)) < 256 * 1024);
  if (visible) assert(Buffer.byteLength(JSON.stringify(reviewedPlanProposal(amended.state))) > 256 * 1024);
  assert.equal(amended.state.features.filter(item => item.metadata.stage === 'version-planning').length, visible ? 1 : 2);
  const retired = await harness.authorityStore.read(descriptor.id, implementation.state.runId);
  assert.equal(retired.status, 'superseded');
  assert.deepEqual(retired.attempts, oldAttempts);
  assert.equal(retired.features.find(item => item.metadata.approvedProposal?.id === 'A0').state, 'completed');
  const closed = await approveAndClose(amended.state);
  assert.equal(closed.state.status, 'closed');
  assert.equal(closed.result.receipt.runId, reviewedAmendment.run.runId);
  const next = await create('implement');
  const ready = await harness.createExecutionReadinessReport(next);
  assert.equal(ready.executionReady, true, JSON.stringify(ready));
  const resumed = await harness.startLifecyclePlan(next, { commandId: 'new-implementation', preflightReport: ready });
  assert.deepEqual(resumed.state.features.filter(item => item.metadata.stage === 'implementation')
    .map(item => item.metadata.approvedProposal.id), ['A1', 'A2']);
  assert.deepEqual(resumed.state.metadata.approvedPlan.amendmentBaseline.completedProposalIds, ['A0']);
  assert.equal(digestJson(retired.attempts), digestJson(oldAttempts));
  // A second amendment must preserve completion inherited by the first one.
  const continued = await execute(next, 'new-implementation');
  assert.equal(continued.state.features.find(item => item.metadata.approvedProposal?.id === 'A1').state, 'blocked');
  const secondPlan = await create('amend', ['change:boundary']);
  const secondAmendment = await execute(secondPlan, 'second-amendment');
  await approveAndClose(secondAmendment.state);
  const secondImplementation = await create('implement');
  const secondReady = await harness.createExecutionReadinessReport(secondImplementation);
  assert.equal(secondReady.executionReady, true, JSON.stringify(secondReady));
  const secondStarted = await harness.startLifecyclePlan(secondImplementation,
    { commandId: 'second-implementation', preflightReport: secondReady });
  assert.deepEqual(secondStarted.state.metadata.approvedPlan.amendmentBaseline.completedProposalIds, ['A0']);
  assert.equal(secondStarted.state.features.some(item => item.metadata.approvedProposal?.id === 'A0'), false);
});
