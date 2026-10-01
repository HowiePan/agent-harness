import { assert } from '../common/errors.mjs';
import { resolve } from 'node:path';
import { captureWorkspace } from '../common/workspace-snapshot.mjs';
import { ExtensionRegistry } from '../platform/extensions/registry.mjs';
import { planApprovalSatisfied } from '../flows/delivery-lifecycle/plan-approval.mjs';
import { createHarness } from './harness.mjs';
import { assessPlanSourceCompatibility, planSourceCompatibilityDecisionId, planSourceCompatibilitySatisfied } from './plan-source-compatibility.mjs';
import { verifyDevelopmentSourceManifest } from './development-source.mjs';
import { createLocalDevelopmentInvocation } from './local-development-invocation.mjs';
import { loadProjectHarnessConfig } from './project-initialization.mjs';

export const assertReviewedSourceDecision = ({ planRun, assessment, decision }) => {
  assert(decision?.id === planSourceCompatibilityDecisionId(assessment)
    && decision.actor === 'operator' && decision.decision === 'approved'
    && typeof decision.reason === 'string' && decision.reason.trim().length >= 32,
  'PLAN_SOURCE_OPERATOR_REVIEW_REQUIRED', 'Source compatibility requires a reasoned operator review.');
  assert(planSourceCompatibilitySatisfied({ ...planRun, decisions: [decision] }, assessment)
    && JSON.stringify(decision.changedFiles) === JSON.stringify(assessment.changedFiles),
  'PLAN_SOURCE_OPERATOR_REVIEW_STALE', 'Operator review does not bind the current plan and exact source delta.');
};

export const assertCurrentPlanLineage = ({ planRun, lineage }) => {
  assert(planRun.metadata?.logicalTaskKey && lineage?.activeRunId === planRun.runId,
    'PLAN_SOURCE_ACTIVE_REVISION_REQUIRED', 'Source review must target the current approved plan revision.');
};

/** Record an exact, reviewed delta from the bound project checkout without broadening plan paths. */
export const recordDevelopmentPlanSourceCompatibility = async ({ manifestFile, runId, decision, commandId, cwd = process.cwd() }) => {
  assert(runId && commandId, 'PLAN_SOURCE_OPERATOR_INPUT_REQUIRED', 'Plan Run and unique command ID are required.');
  const { manifest, releaseIdentity } = await verifyDevelopmentSourceManifest(manifestFile);
  await createLocalDevelopmentInvocation({ projectRoot: manifest.projectRoot, configPath: manifest.configPath,
    controlRoot: manifest.controlRoot, dataRoot: manifest.dataRoot, cwd });
  const config = await loadProjectHarnessConfig(manifest.configPath, { projectRoot: manifest.projectRoot });
  const projectId = config.request.binding.projectId;
  const registry = new ExtensionRegistry({ dataRoot: manifest.dataRoot, controlRoot: manifest.controlRoot, developmentMode: true });
  const extensions = await registry.loadInstalled();
  const harness = await createHarness({ controlRoot: manifest.controlRoot, dataRoot: manifest.dataRoot, releaseIdentity,
    extensions, strictProjectIdentity: false, initializeStorage: false });
  const project = await harness.projectRegistry.get(projectId);
  const sameProjectRoot = project?.workspace?.root && (process.platform === 'win32'
    ? resolve(project.workspace.root).toLowerCase() === resolve(manifest.projectRoot).toLowerCase()
    : resolve(project.workspace.root) === resolve(manifest.projectRoot));
  assert(sameProjectRoot, 'PLAN_SOURCE_PROJECT_BINDING_MISMATCH', 'Plan source review requires the registered project checkout.');
  const planRun = await harness.authorityStore.read(projectId, runId);
  assert(planRun.status === 'closed' && planRun.features.some(feature => feature.metadata?.stage === 'plan-review')
    && planApprovalSatisfied(planRun), 'PLAN_SOURCE_APPROVED_PLAN_REQUIRED', 'Source review requires a closed, user-approved plan Run.');
  assertCurrentPlanLineage({ planRun, lineage: await harness.lineageStore.read(projectId, planRun.metadata?.logicalTaskKey) });
  const sourceRef = planRun.dispatches.findLast(dispatch => dispatch.sourceDigest === planRun.sourceDigest && dispatch.sourceSnapshotRef)?.sourceSnapshotRef;
  assert(sourceRef, 'IMPLEMENTATION_PLAN_SOURCE_EVIDENCE_REQUIRED', 'Approved plan has no source snapshot evidence.');
  const evidence = await harness.evidenceStore.read(sourceRef);
  assert(evidence.metadata.projectId === projectId && evidence.metadata.runId === runId,
    'IMPLEMENTATION_PLAN_SOURCE_EVIDENCE_MISMATCH', 'Plan source evidence belongs to another Run.');
  const excluded = project.workspace.excluded ?? [];
  const currentSnapshot = await captureWorkspace(project.workspace.root, { excluded });
  const assessment = assessPlanSourceCompatibility({ planRun, baselineSnapshot: JSON.parse(evidence.bytes.toString('utf8')),
    currentSnapshot, excluded });
  assert(assessment.changedFiles.length > 0, 'PLAN_SOURCE_OPERATOR_NO_DELTA', 'Current source matches the approved plan.');
  assertReviewedSourceDecision({ planRun, assessment, decision });
  const recorded = await harness.kernel.recordDecision(projectId, runId, decision,
    { expectedRevision: planRun.revision, commandId });
  return { projectId, runId, revision: recorded.state.revision, sourceDigest: currentSnapshot.digest,
    changedFilesDigest: assessment.changedFilesDigest, changedFiles: assessment.changedFiles,
    decision: recorded.result.decision };
};
