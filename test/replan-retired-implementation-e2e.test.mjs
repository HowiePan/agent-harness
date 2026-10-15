import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHarness, createInMemoryRuntime, harnessTemporaryRoot,
  loadExtensionPack, projectExecutionPolicyDecisionContext, projectDescriptorInput } from '../src/index.mjs';
import { createCardWorldProjectDescriptor } from '../integrations/legacy-consumers/cardworld/index.mjs';
import { planApprovalSnapshot } from '../src/flows/delivery-lifecycle/plan-approval.mjs';
import { RunLineageStore } from '../src/application/lineage.mjs';
import { commitUnacceptedDevelopmentRetirement } from '../src/application/development-run-recovery.mjs';
import { captureWorkspace } from '../src/common/workspace-snapshot.mjs';
import { assertDevelopmentReplacementScope } from '../src/application/development-replacement-scope.mjs';
import { createTestExecutionAuthorizationAdapter } from './test-support.mjs';

test('a failed retired implementation enters Replan without rewriting its outcome or approved parent', async t => {
  const controlRoot = resolve(process.cwd());
  const parent = resolve(harnessTemporaryRoot(), 'replan-retired-implementation-tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'case-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = resolve(root, 'CardWorld');
  await mkdir(resolve(workspaceRoot, '.git'), { recursive: true });
  await writeFile(resolve(workspaceRoot, 'README.md'), '# Synthetic Engine\n');
  const engine = await loadExtensionPack('./integrations/legacy-consumers/cardworld/index.mjs', { cwd: controlRoot, controlRoot });
  const harness = await createHarness({ controlRoot, dataRoot: resolve(root, 'data'),
    releaseIdentity: { version: '1.0.0', artifactDigest: 'a'.repeat(64), verified: true }, strictProjectIdentity: false,
    extensions: [engine], executionAuthorizationAdapter: createTestExecutionAuthorizationAdapter() });
  const runtimeManifest = { id: 'test-runtime', kind: 'agent-runtime', version: '1.0.0',
    capabilities: ['spawn', 'wait', 'send', 'heartbeat', 'interrupt', 'headless'], permissions: [] };
  harness.registerPlugin(runtimeManifest, createInMemoryRuntime({ manifest: runtimeManifest,
    handler: async () => ({ status: 'completed', summary: 'synthetic', changedFiles: [] }) }));
  const descriptor = createCardWorldProjectDescriptor({ id: 'engine-replan-fixture', workspaceRoot,
    runtimePluginId: runtimeManifest.id, runtimePluginIds: [runtimeManifest.id], agentExecutionMode: 'headless',
    planChangeRequests: { 'CR-1': { target: 'V1.0.0', kind: 'technical', summary: 'Revise one Engine contract',
      requirements: ['Update the synthetic Engine contract'], acceptance: ['The revised plan is reviewed'] } } });
  descriptor.gateRecipes = [];
  // Reproduce the pre-repair Descriptor that omitted guidance writes.
  descriptor.policy.actionPaths.implement = descriptor.policy.actionPaths.implement
    .filter(path => !['AGENTS.md', '.agent/skills'].includes(path));
  delete descriptor.policy.planArchiveRoot;
  descriptor.extensions[0].digest = engine.digest;
  descriptor.workflows = [{ id: engine.workflows[0].id, version: engine.workflows[0].version,
    artifactDigest: engine.workflows[0].artifactDigest, extensionId: engine.id }];
  await harness.projectRegistry.register(descriptor, { commandId: 'register-engine-replan-fixture',
    authorityDecision: { actor: 'test', decision: 'approved', action: 'project-execution-policy-change',
      expiresAt: '2099-01-01T00:00:00.000Z', context: projectExecutionPolicyDecisionContext({ input: descriptor, expectedRevision: 0 }) } });
  const plan = await harness.createLifecyclePlan({ projectId: descriptor.id, action: 'plan', target: 'V1.0.0',
    extensionId: engine.id, executionWorkspaceRoot: workspaceRoot,
    executionAuthorizationEvidence: { explicitUnattended: true } });
  const planPreflight = await harness.createExecutionReadinessReport(plan);
  assert.equal(planPreflight.executionReady, true);
  const startedPlan = await harness.startLifecyclePlan(plan, { commandId: 'plan-command', preflightReport: planPreflight });
  const scheduledPlan = await harness.dispatch(descriptor.id, plan.run.runId,
    { maxConcurrency: 1, runtimePluginId: runtimeManifest.id },
    { expectedRevision: startedPlan.state.revision, commandId: 'schedule-plan-snapshot' });
  assert.equal(scheduledPlan.result.dispatches.length, 1);
  assert.ok(scheduledPlan.state.dispatches[0].sourceSnapshotRef);
  const planFeature = startedPlan.state.features.find(feature => feature.metadata.stage === 'version-planning');
  const reviewFeature = startedPlan.state.features.find(feature => feature.metadata.stage === 'plan-review');
  const typedPlan = { features: ['F-14'], proposedFeatures: [{ id: 'F-14', projectId: descriptor.id,
    disposition: 'project-owned', allowedPaths: ['README.md'], dependsOn: [], contracts: [], verification: [] }] };
  const planned = await harness.authorityStore.transact(descriptor.id, plan.run.runId,
    { expectedRevision: scheduledPlan.state.revision, commandId: 'synthetic-reviewed-plan', payload: {} }, state => {
      state.features.forEach(feature => { feature.state = 'completed'; });
      state.dispatches.forEach(dispatch => { dispatch.status = 'superseded'; });
      state.submissions = [
        { featureId: planFeature.id, result: { status: 'completed', outputs: { plan: { value: typedPlan } } } },
        { featureId: reviewFeature.id, result: { status: 'completed', outputs: { 'plan-review': { value: { approved: true, findings: [] } } } } },
      ];
      return { reviewed: true };
    });
  const approval = planApprovalSnapshot(planned.state);
  assert.equal(approval.reviewApproved, true);
  const approved = await harness.kernel.recordDecision(descriptor.id, plan.run.runId,
    { id: 'implementation-plan-approved', actor: 'test-user', decision: 'approved',
      projectId: descriptor.id, runId: plan.run.runId, planDigest: approval.planDigest,
      artifactDigest: approval.artifactDigest },
    { expectedRevision: planned.state.revision, commandId: 'approve-synthetic-plan' });
  const closed = await harness.authorityStore.transact(descriptor.id, plan.run.runId,
    { expectedRevision: approved.state.revision, commandId: 'close-synthetic-plan', payload: {} }, state => {
      state.status = 'closed';
      return { closed: true };
    });
  const implementation = await harness.createLifecyclePlan({ projectId: descriptor.id, action: 'implement', target: 'V1.0.0',
    extensionId: engine.id, executionWorkspaceRoot: workspaceRoot,
    executionAuthorizationEvidence: { explicitUnattended: true } });
  const implementationPreflight = await harness.createExecutionReadinessReport(implementation);
  assert.equal(implementationPreflight.executionReady, true);
  const startedImplementation = await harness.startLifecyclePlan(implementation,
    { commandId: 'implement-command', preflightReport: implementationPreflight });
  const syntheticActive = await harness.authorityStore.transact(descriptor.id, implementation.run.runId,
    { expectedRevision: startedImplementation.state.revision, commandId: 'synthetic-active-f14', payload: {} }, state => {
      const feature = state.features.find(item => item.metadata.stage === 'implementation');
      feature.state = 'running';
      state.dispatches.push({ dispatchId: 'dispatch-f14', featureId: feature.id, status: 'assigned' });
      state.leases.push({ leaseId: 'lease-f14', dispatchId: 'dispatch-f14', status: 'active' });
      state.status = 'running';
      return { featureId: feature.id };
    });
  const old = syntheticActive.state;
  const activeFeature = old.features.find(item => item.id === syntheticActive.result.featureId);
  await writeFile(resolve(workspaceRoot, 'README.md'), '# Synthetic Engine revised\n');
  const observedSourceDigest = (await captureWorkspace(workspaceRoot, { excluded: descriptor.workspace.excluded })).digest;
  assert.notEqual(observedSourceDigest, old.sourceDigest);
  const evidenceBody = { kind: 'unaccepted-terminal-result-retirement', version: '1.0',
    priorAuthorityDigest: old.authorityDigest, patchReceiptDigest: 'b'.repeat(64),
    hostObservationReceipt: { receiptDigest: 'c'.repeat(64) }, originalResultDigest: 'd'.repeat(64),
    rejection: { code: 'FEATURE_PATH_NOT_ALLOWED', rejectedPaths: ['README.md'] },
    sourceDelta: { fromSourceDigest: old.sourceDigest, observedSourceDigest,
      claimedChangedFiles: ['README.md'], unclaimedChangedPaths: [] } };
  const evidence = await harness.evidenceStore.put(evidenceBody, { projectId: descriptor.id, runId: old.runId,
    epoch: old.epoch, generation: old.generation, featureId: activeFeature.id, dispatchId: 'dispatch-f14',
    sourceDigest: old.sourceDigest, artifactDigest: old.artifactDigest,
    policyDigest: old.policyDigest, pluginSetDigest: old.pluginSetDigest });
  const retirement = { authorityStore: harness.authorityStore, evidenceStore: harness.evidenceStore,
    state: old, lease: old.leases[0], dispatch: old.dispatches[0], feature: activeFeature,
    evidenceRef: evidence.ref, patchReceiptDigest: evidenceBody.patchReceiptDigest,
    hostReceiptDigest: evidenceBody.hostObservationReceipt.receiptDigest,
    resultDigest: evidenceBody.originalResultDigest, observedSourceDigest,
    claimedChangedFiles: ['README.md'], unclaimedChangedPaths: [], commandId: 'retire-f14' };
  const retired = await commitUnacceptedDevelopmentRetirement(retirement);
  assert.equal(retired.status, 'failed');
  assert.deepEqual(await commitUnacceptedDevelopmentRetirement(retirement), retired);
  const replanInput = { projectId: descriptor.id, action: 'replan', target: 'V1.0.0',
    arguments: ['change:CR-1'], extensionId: engine.id, executionWorkspaceRoot: workspaceRoot,
    executionAuthorizationEvidence: { explicitUnattended: true } };
  let revised = await harness.createLifecyclePlan(replanInput);
  assert.equal(revised.intent.planRevision.parentRunId, plan.run.runId);
  assert.equal(revised.intent.planRevision.parentPlanDigest, approval.planDigest);
  assert.deepEqual(revised.intent.planRevision.parentPlan, typedPlan);
  assert.equal(revised.intent.planRevision.parentSourceDigest, plan.run.sourceDigest);
  assert.deepEqual(revised.intent.planRevision.revisionBasis.map(item => item.kind),
    ['registered-change-request', 'verified-source-delta']);
  assert.deepEqual(revised.intent.planRevision.revisionBasis[1].changedPaths, ['README.md']);
  assert.equal(revised.run.sourceDigest, observedSourceDigest);
  assert.deepEqual(revised.intent.planRevision.affectedImplementationRuns.map(run => run.runId), [old.runId]);
  let revisedPreflight = await harness.createExecutionReadinessReport(revised);
  assert.equal(revisedPreflight.executionReady, true);
  const lineageStore = new RunLineageStore({ root: resolve(root, 'data'), controlRoot });
  const priorLineage = await lineageStore.read(descriptor.id, revised.logicalTaskKey);
  assert.equal(priorLineage.activeRunId, plan.run.runId);
  const staleRunId = revised.run.runId;
  const audited = await harness.authorityStore.transact(descriptor.id, old.runId,
    { expectedRevision: retired.priorRevision, commandId: 'audit-retired-evidence', payload: {} }, state => {
      state.metadata.retirementAuditChecked = true;
      return { checked: true };
    });
  await assert.rejects(() => harness.startLifecyclePlan(revised,
    { commandId: 'stale-replan-command', preflightReport: revisedPreflight }),
  error => error.code === 'REPLAN_IMPLEMENTATION_CHANGED');
  assert.equal(await harness.authorityStore.read(descriptor.id, staleRunId, { required: false }), null);
  assert.equal((await lineageStore.read(descriptor.id, revised.logicalTaskKey)).revision, priorLineage.revision);
  revised = await harness.createLifecyclePlan(replanInput);
  assert.equal(revised.intent.planRevision.parentRunId, plan.run.runId);
  assert.equal(revised.intent.planRevision.affectedImplementationRuns[0].revision, audited.state.revision);
  revisedPreflight = await harness.createExecutionReadinessReport(revised);
  assert.equal(revisedPreflight.executionReady, true);
  const replacement = await harness.startLifecyclePlan(revised,
    { commandId: 'replan-command', preflightReport: revisedPreflight });
  assert.equal(replacement.state.runId, revised.run.runId);
  assert.equal(replacement.status, 'started');
  assert.deepEqual(replacement.state.features.map(feature => feature.metadata.stage), ['version-planning', 'plan-review']);
  const preserved = await harness.authorityStore.read(descriptor.id, old.runId);
  assert.equal(preserved.revision, audited.state.revision);
  assert.equal(preserved.status, 'failed');
  assert.equal(preserved.metadata.terminalOutcome.reason, 'unaccepted-terminal-result-for-replan');
  assert.equal(preserved.features.find(feature => feature.id === activeFeature.id).state, 'blocked');
  assert.equal(preserved.submissions.length, 0);
  assert.deepEqual(preserved.metadata.terminalOutcome.evidenceRefs, [evidence.ref]);
  const parentAfter = await harness.authorityStore.read(descriptor.id, plan.run.runId);
  assert.equal(parentAfter.revision, closed.state.revision);
  assert.equal(parentAfter.status, 'closed');
  const retried = await harness.startLifecyclePlan(revised,
    { commandId: 'replan-command', preflightReport: revisedPreflight });
  assert.equal(retried.state.runId, replacement.state.runId);
  assert.equal((await harness.authorityStore.read(descriptor.id, old.runId)).revision, preserved.revision);

  // Approve the replacement, then exercise the next implement invocation through
  // preflight and Run creation. The old failed F-14 must never be resumed or
  // promoted to completion, nor block the replacement's fresh work packages.
  const replacementProposal = { features: ['A-00', 'A-01'], proposedFeatures: ['A-00', 'A-01'].map((id, index) => ({
    id, projectId: descriptor.id, disposition: 'project-owned', allowedPaths: index ? ['card_world_engine'] : ['AGENTS.md', '.agent/skills'],
    dependsOn: index ? ['A-00'] : [], contracts: [], verification: [],
  })) };
  const reviewedReplacement = await harness.authorityStore.transact(descriptor.id, revised.run.runId,
    { expectedRevision: retried.state.revision, commandId: 'review-replacement-plan', payload: {} }, state => {
      state.features.forEach(feature => { feature.state = 'completed'; });
      state.submissions = [
        { featureId: state.features.find(feature => feature.metadata.stage === 'version-planning').id,
          result: { status: 'completed', outputs: { plan: { value: replacementProposal } } } },
        { featureId: state.features.find(feature => feature.metadata.stage === 'plan-review').id,
          result: { status: 'completed', outputs: { 'plan-review': { value: { approved: true, findings: [] } } } } },
      ];
      return { reviewed: true };
    });
  const replacementApproval = planApprovalSnapshot(reviewedReplacement.state);
  const approvedReplacement = await harness.kernel.recordDecision(descriptor.id, revised.run.runId,
    { id: 'implementation-plan-approved', actor: 'test-user', decision: 'approved',
      projectId: descriptor.id, runId: revised.run.runId, planDigest: replacementApproval.planDigest,
      artifactDigest: replacementApproval.artifactDigest },
    { expectedRevision: reviewedReplacement.state.revision, commandId: 'approve-replacement-plan' });
  await harness.authorityStore.transact(descriptor.id, revised.run.runId,
    { expectedRevision: approvedReplacement.state.revision, commandId: 'close-replacement-plan', payload: {} }, state => {
      state.status = 'closed';
      return { closed: true };
    });
  const nextImplementation = await harness.createLifecyclePlan({ projectId: descriptor.id, action: 'implement', target: 'V1.0.0',
    extensionId: engine.id, executionWorkspaceRoot: workspaceRoot,
    executionAuthorizationEvidence: { explicitUnattended: true } });
  assert.notEqual(nextImplementation.run.runId, old.runId);
  const nextReadiness = await harness.createExecutionReadinessReport(nextImplementation);
  assert.equal(nextReadiness.executionReady, true, JSON.stringify(nextReadiness.checks.filter(check => !check.ready)));
  assert.equal(nextReadiness.checks.find(check => check.id === 'run-lineage').details.resolution.reasonCode,
    'APPROVED_REPLAN_REPLACES_TERMINAL_IMPLEMENTATION');
  const nextStarted = await harness.startLifecyclePlan(nextImplementation,
    { commandId: 'implement-replacement-command', preflightReport: nextReadiness });
  assert.equal(nextStarted.state.metadata.approvedPlan.runId, revised.run.runId);
  assert.equal(nextStarted.state.metadata.approvedPlan.planDigest, replacementApproval.planDigest);
  assert.deepEqual(nextStarted.state.features.filter(feature => feature.metadata.stage === 'implementation')
    .map(feature => feature.metadata.approvedProposal.id), ['A-00', 'A-01']);
  assert.ok(nextStarted.state.features.every(feature => feature.state === 'pending'));
  assert.equal((await lineageStore.read(descriptor.id, nextImplementation.logicalTaskKey)).activeRunId, nextStarted.state.runId);
  assert.deepEqual(await harness.authorityStore.read(descriptor.id, old.runId), preserved);
  const repeatImplementation = await harness.startLifecyclePlan(nextImplementation,
    { commandId: 'implement-replacement-command', preflightReport: nextReadiness });
  assert.equal(repeatImplementation.reused, true);
  assert.equal(repeatImplementation.state.runId, nextStarted.state.runId);

  const registered = await harness.projectRegistry.get(descriptor.id);
  const repaired = projectDescriptorInput(registered);
  repaired.policy.actionPaths.implement.unshift('AGENTS.md', '.agent/skills');
  const updated = await harness.projectRegistry.register(repaired,
    { expectedRevision: registered.revision, commandId: 'repair-guidance-scope',
      authorityDecision: { actor: 'test-user', decision: 'approved', action: 'project-descriptor-update' } });
  const recoveryInput = { projectId: descriptor.id, action: 'implement', target: 'V1.0.0',
    extensionId: engine.id, executionWorkspaceRoot: workspaceRoot,
    executionAuthorizationEvidence: { explicitUnattended: true } };
  const beforeRetirement = await harness.createLifecyclePlan(recoveryInput);
  const scopeRetired = await harness.kernel.supersedeRun(descriptor.id, nextStarted.state.runId,
    { replacementRunId: beforeRetirement.run.runId, planDigest: beforeRetirement.planDigest,
      reason: `development-h2-recovery:${'e'.repeat(64)}` },
    { expectedRevision: repeatImplementation.state.revision, commandId: 'retire-guidance-blocked-run' });
  const afterRetirement = await harness.createLifecyclePlan(recoveryInput);
  assert.notEqual(afterRetirement.planDigest, beforeRetirement.planDigest);
  assertDevelopmentReplacementScope({ retired: scopeRetired.state, plan: afterRetirement, project: updated });
  const recoveryReady = await harness.createExecutionReadinessReport(afterRetirement);
  assert.equal(recoveryReady.executionReady, true, JSON.stringify(recoveryReady.checks.filter(check => !check.ready)));
  const recoveryStarted = await harness.startLifecyclePlan(afterRetirement,
    { commandId: 'implement-after-guidance-recovery', preflightReport: recoveryReady });
  const recoveryDispatch = await harness.dispatch(descriptor.id, recoveryStarted.state.runId,
    { maxConcurrency: 1, runtimePluginId: runtimeManifest.id },
    { expectedRevision: recoveryStarted.state.revision, commandId: 'dispatch-after-guidance-recovery' });
  const packet = recoveryDispatch.result.dispatches[0].packet;
  assert.equal(packet.feature.metadata.approvedProposal.id, 'A-00');
  assert(packet.feature.allowedPaths.includes('AGENTS.md'));
  assert(packet.feature.allowedPaths.includes('.agent/skills'));
  const binding = packet.workflowContext.taskInputs.find(input => input.id === 'approved-plan-binding').value;
  assert.equal(binding.runId, revised.run.runId);
  assert.equal(binding.planDigest, replacementApproval.planDigest);
  assert.equal(binding.artifactDigest, replacementApproval.artifactDigest);
  assert.equal(binding.approvalDecision.actor, 'test-user');
  assert.equal(binding.approvalDecision.decision, 'approved');
  assert.equal(binding.approvalDecision.runId, revised.run.runId);
  assert(packet.feature.forbiddenPaths.includes('tabletop-collection'));
  assert.deepEqual(await harness.authorityStore.read(descriptor.id, old.runId), preserved);
  assert.equal((await harness.authorityStore.read(descriptor.id, nextStarted.state.runId)).status, 'superseded');
});
