import { resolve } from 'node:path';
import { assert } from '../common/errors.mjs';
import { digestJson } from '../common/canonical.mjs';
import { captureWorkspace } from '../common/workspace-snapshot.mjs';
import { ExtensionRegistry } from '../platform/extensions/registry.mjs';
import { planApprovalSnapshot, planApprovalSatisfied } from '../flows/delivery-lifecycle/plan-approval.mjs';
import { createHarness } from './harness.mjs';
import { verifyDevelopmentSourceManifest } from './development-source.mjs';
import { createLocalDevelopmentInvocation } from './local-development-invocation.mjs';
import { loadProjectHarnessConfig } from './project-initialization.mjs';
import { assessPlanSourceCompatibility } from './plan-source-compatibility.mjs';
import { assessPlanArchiveSourceCompatibility, ensureProjectPlanArchive } from './plan-archive.mjs';
import { planReviewResolutionCandidates, verifyPlanReviewResolutionEvidence, reconcilePlanReviewFindings } from './plan-review-reconciliation.mjs';

export const assertCompletedPlanCloseoutScope = ({ state, project, repair, expectedRevision }) => {
  const snapshot = planApprovalSnapshot(state);
  const samePath = value => value && resolve(value).toLowerCase() === resolve(project.workspace.root).toLowerCase();
  assert(state.projectId === project.id && state.revision === expectedRevision
    && ['closure-blocked', 'ready-to-close', 'closed'].includes(state.status)
    && ['plan', 'replan', 'amend'].includes(state.metadata?.commandIntent?.action)
    && samePath(state.metadata?.workspace?.root)
    && state.features.length > 0 && state.features.every(feature => feature.state === 'completed'
      && ['version-planning', 'plan-review'].includes(feature.metadata?.stage))
    && !state.leases.some(lease => lease.status === 'active')
    && !state.dispatches.some(dispatch => ['requested', 'assigned', 'bound'].includes(dispatch.status))
    && snapshot?.reviewApproved && planApprovalSatisfied(state)
    && repair?.kind === 'reviewed-plan-closeout-repair' && repair.actor === 'operator'
    && repair.projectId === state.projectId && repair.runId === state.runId
    && repair.planDigest === snapshot.planDigest && repair.artifactDigest === snapshot.artifactDigest
    && Array.isArray(repair.legacyAssessments),
  'DEVELOPMENT_PLAN_CLOSEOUT_SCOPE_MISMATCH', 'Closeout repair requires the exact approved, completed, idle planning Run and registered checkout.');
  return snapshot;
};

/** Repair sealed control projections only. Never start/resume a Feature or rebind a Lease. */
export const closeCompletedReviewedPlan = async ({ harness, project, runId, repair, expectedRevision, commandId, checkOnly = false }) => {
  assert(commandId, 'COMMAND_ID_REQUIRED', 'Plan closeout repair requires a stable command ID.');
  let state = await harness.authorityStore.read(project.id, runId);
  const snapshot = assertCompletedPlanCloseoutScope({ state, project, repair, expectedRevision });
  if (state.metadata.logicalTaskKey) await harness.lineageStore.assertActive(project.id, state.metadata.logicalTaskKey, runId);
  const sourceRef = state.dispatches.findLast(dispatch => dispatch.sourceDigest === state.sourceDigest && dispatch.sourceSnapshotRef)?.sourceSnapshotRef;
  assert(sourceRef, 'IMPLEMENTATION_PLAN_SOURCE_EVIDENCE_REQUIRED', 'Completed plan has no sealed source snapshot.');
  const sourceEvidence = await harness.evidenceStore.read(sourceRef);
  assert(sourceEvidence.metadata.projectId === project.id && sourceEvidence.metadata.runId === runId,
    'IMPLEMENTATION_PLAN_SOURCE_EVIDENCE_MISMATCH', 'Plan source snapshot belongs to another Run.');
  const currentSnapshot = await captureWorkspace(project.workspace.root, { excluded: project.workspace.excluded ?? [] });
  const assessment = assessPlanSourceCompatibility({ planRun: state,
    baselineSnapshot: JSON.parse(sourceEvidence.bytes.toString('utf8')), currentSnapshot, excluded: project.workspace.excluded ?? [] });
  assert(assessment.changedFiles.length === 0 || assessPlanArchiveSourceCompatibility({ project, planRun: state, assessment, currentSnapshot }),
    'IMPLEMENTATION_PLAN_SOURCE_MISMATCH', 'Closeout repair cannot admit project drift beyond the exact reviewed archive.');
  const candidates = planReviewResolutionCandidates(state, repair.legacyAssessments);
  await verifyPlanReviewResolutionEvidence(state, candidates, harness.evidenceStore);
  const unresolved = state.findings.filter(finding => finding.status !== 'resolved' && !candidates.some(candidate => candidate.id === finding.id));
  assert(unresolved.length === 0, 'QUALITY_FINDINGS_OPEN', 'Every open Finding requires its own verified resolution.', { ids: unresolved.map(item => item.id) });
  const profile = harness.profileRegistry.get(state.profile.id);
  assert(profile.canClose(state).ok, 'DEVELOPMENT_PLAN_CLOSEOUT_PROFILE_BLOCKED', 'Plan closure still has a Profile blocker.');
  const archiveInput = { project, state, workspaceRoot: project.workspace.root,
    previousPlanRuns: (await harness.authorityStore.list(project.id)).filter(run => run.runId !== runId) };
  const archivePreview = await ensureProjectPlanArchive({ ...archiveInput, dryRun: true });
  if (checkOnly) return { projectId: project.id, runId, status: state.status, revision: state.revision,
    planDigest: snapshot.planDigest, artifactDigest: snapshot.artifactDigest,
    approvalSatisfied: true, resolvedIds: [], repairableIds: candidates.map(item => item.id),
    archive: archivePreview, implementationPlanReady: state.status === 'closed' && unresolved.length === 0
      && candidates.length === 0 && !archivePreview?.updateRequired,
    featureExecutionStarted: false };
  const reconciled = await reconcilePlanReviewFindings({ state, kernel: harness.kernel, evidenceStore: harness.evidenceStore,
    commandId, legacyAssessments: repair.legacyAssessments });
  state = reconciled.state;
  const archive = await ensureProjectPlanArchive({ ...archiveInput, state });
  assert(digestJson(planApprovalSnapshot(state)) === digestJson(snapshot),
    'DEVELOPMENT_PLAN_CLOSEOUT_ARTIFACT_CHANGED', 'Control reconciliation changed the approved Plan.');
  if (state.status !== 'closed') {
    state = (await harness.kernel.closeRun(project.id, runId, {},
      { expectedRevision: state.revision, commandId: `${commandId}.close` })).state;
  }
  return { projectId: project.id, runId, status: state.status, revision: state.revision,
    planDigest: snapshot.planDigest, artifactDigest: snapshot.artifactDigest, approvalSatisfied: planApprovalSatisfied(state),
    resolvedIds: reconciled.resolvedIds, archive, featureExecutionStarted: false };
};

export const closeDevelopmentReviewedPlan = async ({ manifestFile, runId, repair, expectedRevision, commandId, checkOnly = false, cwd = process.cwd() }) => {
  const { manifest, releaseIdentity } = await verifyDevelopmentSourceManifest(manifestFile);
  await createLocalDevelopmentInvocation({ projectRoot: manifest.projectRoot, configPath: manifest.configPath,
    controlRoot: manifest.controlRoot, dataRoot: manifest.dataRoot, cwd });
  const config = await loadProjectHarnessConfig(manifest.configPath, { projectRoot: manifest.projectRoot });
  const registry = new ExtensionRegistry({ dataRoot: manifest.dataRoot, controlRoot: manifest.controlRoot, developmentMode: true });
  const harness = await createHarness({ controlRoot: manifest.controlRoot, dataRoot: manifest.dataRoot, releaseIdentity,
    extensions: await registry.loadInstalled(), strictProjectIdentity: false, initializeStorage: false });
  const project = await harness.projectRegistry.get(config.request.binding.projectId);
  assert(resolve(project.workspace.root).toLowerCase() === resolve(manifest.projectRoot).toLowerCase(),
    'PLAN_SOURCE_PROJECT_BINDING_MISMATCH', 'Closeout repair requires the registered project checkout.');
  return closeCompletedReviewedPlan({ harness, project, runId, repair, expectedRevision, commandId, checkOnly });
};
