import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assert } from '../common/errors.mjs';
import { assertHarnessWritePath } from '../common/write-boundary.mjs';
import { AuthorityStore } from '../kernel/authority-store.mjs';
import { EvidenceStore } from '../kernel/evidence-store.mjs';
import { createCompletionCarryoverPlan, verifyCompletionCarryover } from '../kernel/completion-carryover.mjs';
import { loadExtensionPack } from '../platform/extensions/contract.mjs';
import { expandApprovedImplementation } from '../flows/delivery-lifecycle/approved-implementation.mjs';
import { createHarness } from './harness.mjs';
import { loadProjectHarnessConfig } from './project-initialization.mjs';
import { CodexHostEffectJournal } from './codex-host-effect-journal.mjs';
import { assertDevelopmentRunRecoveryEffects, assertH4QualityRestartable } from './development-run-recovery.mjs';

/** Preview the replacement graph under the future H4 source before changing its binding. */
export const previewDevelopmentH4Migration = async ({ plan, manifest, runId }) => {
  assert(plan.level === 'H4' && plan.activeRuns.length === 1
    && plan.activeRuns[0].runId === runId && plan.activeRuns[0].activeLeaseIds.length === 0
    && plan.activeRuns[0].activeDispatchIds.length === 0,
  'DEVELOPMENT_H4_MIGRATION_RUN_CHANGED', 'H4 preview requires the exact single idle Run.');
  const controlRoot = resolve(manifest.controlRoot);
  const authorityStore = new AuthorityStore({ root: manifest.dataRoot, controlRoot });
  const evidenceStore = new EvidenceStore({ root: manifest.dataRoot, controlRoot });
  const prior = await authorityStore.read(plan.activeRuns[0].projectId, runId);
  const implementation = prior.metadata?.commandIntent?.action === 'implement'
    && prior.metadata?.approvedPlan?.typedPlan;
  const quality = prior.metadata?.commandIntent?.action === 'quality';
  const reviewedPlan = ['plan', 'replan'].includes(prior.metadata?.commandIntent?.action)
    && prior.status === 'closure-blocked'
    && prior.features.some(feature => feature.metadata?.stage === 'plan-review' && feature.state === 'completed')
    && prior.features.every(feature => feature.state === 'completed');
  assert(prior.revision === plan.activeRuns[0].revision && prior.status === plan.activeRuns[0].status
    && (implementation || quality || reviewedPlan),
  'DEVELOPMENT_H4_MIGRATION_RUN_CHANGED', 'H4 preview requires an unchanged reviewed Plan, approved implementation, or quality Run.');
  if (quality) assertH4QualityRestartable(prior);
  if (prior.dispatches.length || prior.leases.length) {
    const contract = prior.leases.find(lease => lease.runtimeReceipt?.hostSpawnReceipt)?.runtimeReceipt.hostSpawnReceipt.contract;
    assert(contract, 'DEVELOPMENT_RUN_HOST_CONTRACT_REQUIRED', 'H4 migration requires the original Host contract.');
    const effects = new CodexHostEffectJournal({ controlRoot, dataRoot: manifest.dataRoot, contract });
    assertDevelopmentRunRecoveryEffects(prior, await effects.list());
  }
  const loaded = await loadProjectHarnessConfig(manifest.configPath, { projectRoot: manifest.projectRoot });
  const extensions = await Promise.all(loaded.request.extensions.map(item => loadExtensionPack(item.module,
    { cwd: controlRoot, controlRoot })));
  const generator = extensions.find(item => item.id === loaded.request.project.generatorExtensionId);
  const draft = generator.operations.createProjectDescriptor(loaded.request.project.input);
  const descriptor = { ...draft, harness: { version: manifest.release.version, artifactDigest: plan.after.runtimeDigest },
    extensions: (draft.extensions ?? []).map(item => {
      const installed = extensions.find(extension => extension.id === item.id);
      assert(installed && installed.version === item.version, 'DEVELOPMENT_H4_EXTENSION_MISSING', `Future Project is missing Extension ${item.id}.`);
      return { id: item.id, version: item.version, digest: installed.digest };
    }) };
  const parent = assertHarnessWritePath(resolve(controlRoot, '.tmp', 'development-h4-preflight'), 'H4 preview parent', controlRoot);
  await mkdir(parent, { recursive: true });
  const tempRoot = assertHarnessWritePath(await mkdtemp(resolve(parent, 'case-')), 'H4 preview directory', controlRoot);
  try {
    const harness = await createHarness({ controlRoot, dataRoot: tempRoot,
      releaseIdentity: { version: manifest.release.version, artifactDigest: plan.after.runtimeDigest,
        verified: true, development: true }, extensions, strictProjectIdentity: false });
    await harness.projectRegistry.register(descriptor, { expectedRevision: 0, commandId: 'h4-preview-project' });
    const copy = structuredClone(prior);
    delete copy.authorityDigest; delete copy.commands; delete copy.revision;
    await harness.authorityStore.create(copy, { commandId: 'h4-preview-prior' });
    if (reviewedPlan) {
      for (const ref of new Set(prior.dispatches.map(dispatch => dispatch.sourceSnapshotRef).filter(Boolean))) {
        const record = await evidenceStore.read(ref);
        const stored = await harness.evidenceStore.put(record.bytes, record.metadata);
        assert(stored.ref === ref, 'DEVELOPMENT_H4_PLAN_EVIDENCE_MISMATCH', 'H4 Plan preview could not preserve the original source snapshot evidence.');
      }
    }
    const intent = prior.metadata.commandIntent;
    const extension = extensions.find(item => item.workflows?.some(workflow => workflow.id === intent.workflowId)
      && item.commandManifest?.id === intent.manifestId);
    assert(extension, 'DEVELOPMENT_H4_EXTENSION_MISSING', 'Future implementation Workflow is unavailable.');
    const replacement = await harness.createLifecyclePlan({ projectId: prior.projectId,
      extensionId: extension.id, workflowId: intent.workflowId, profileId: intent.profileId,
      action: intent.action, target: intent.target,
      arguments: intent.preset === 'default' ? [] : [intent.preset],
      executionWorkspaceRoot: prior.metadata.workspace.root });
    if (!reviewedPlan) assert(replacement.run.sourceDigest === prior.sourceDigest,
      'DEVELOPMENT_H4_SOURCE_CHANGED', 'H4 migration requires the exact authoritative project source.');
    if (reviewedPlan) return { projectId: prior.projectId, priorRunId: runId,
      priorRevision: prior.revision, priorAuthorityDigest: prior.authorityDigest,
      sourceDigest: prior.sourceDigest, replacementSourceDigest: replacement.run.sourceDigest,
      replacementRunId: replacement.run.runId, replacementPlanDigest: replacement.planDigest,
      terminalOutcome: { status: 'superseded', reason: 'development-h4-plan-revision' } };
    if (prior.metadata.commandIntent.action === 'quality') {
      assertH4QualityRestartable(prior);
      const evidenceRefs = [...new Set(prior.submissions.flatMap(item => item.evidenceRefs ?? []))];
      assert(evidenceRefs.length > 0, 'DEVELOPMENT_H4_QUALITY_EVIDENCE_REQUIRED', 'The stopped quality Run has no submission evidence.');
      for (const ref of evidenceRefs) {
        const record = await evidenceStore.read(ref);
        assert(record.metadata.projectId === prior.projectId && record.metadata.runId === runId,
          'DEVELOPMENT_H4_QUALITY_EVIDENCE_INVALID', 'Quality submission evidence belongs to another Run.');
      }
      return { projectId: prior.projectId, priorRunId: runId, priorRevision: prior.revision,
        priorAuthorityDigest: prior.authorityDigest, sourceDigest: prior.sourceDigest,
        terminalOutcome: { status: 'failed', reason: 'development-h4-quality-restart' },
        newQualityCommandReady: true };
    }
    if (prior.features.every(feature => feature.state === 'completed')
      && harness.profileRegistry.get(prior.profile.id).canClose(prior).reason === 'quality-review-limit-reached') {
      return { projectId: prior.projectId, priorRunId: runId, priorRevision: prior.revision,
        priorAuthorityDigest: prior.authorityDigest, sourceDigest: prior.sourceDigest,
        completedFeatureIds: prior.features.filter(feature => feature.metadata?.stage === 'implementation').map(feature => feature.id),
        terminalOutcome: { status: 'incomplete', reason: 'quality-review-limit-reached' } };
    }
    const replacementFeatures = expandApprovedImplementation({ features: replacement.run.features,
      typedPlan: prior.metadata.approvedPlan.typedPlan, projectId: prior.projectId, approvalBinding: prior.metadata.approvedPlan });
    const carryover = createCompletionCarryoverPlan({ prior, replacementFeatures,
      replacementRunId: replacement.run.runId, replacementPlanDigest: replacement.planDigest,
      patchReceiptDigest: '0'.repeat(64), sourceDigest: replacement.run.sourceDigest });
    await verifyCompletionCarryover({ plan: carryover, prior, replacementFeatures, evidenceStore, authorityStore });
    return { projectId: prior.projectId, priorRunId: runId, priorRevision: prior.revision,
      priorAuthorityDigest: prior.authorityDigest, sourceDigest: prior.sourceDigest,
      completedFeatureIds: carryover.completedSubmissions.map(item => item.featureId),
      firstPendingFeatureId: carryover.firstPendingFeatureId,
      priorWorkflowDigest: carryover.priorWorkflowDigest,
      replacementWorkflowDigest: carryover.replacementWorkflowDigest };
  } finally { await rm(tempRoot, { recursive: true, force: true }); }
};
