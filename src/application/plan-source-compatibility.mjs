import { digestJson } from '../common/canonical.mjs';
import { assert } from '../common/errors.mjs';
import { diffWorkspaceSnapshots } from '../common/workspace-snapshot.mjs';
import { resolve } from 'node:path';
import { planApprovalSnapshot, reviewedPlanProposal } from '../flows/delivery-lifecycle/plan-approval.mjs';
import { CodexHostEffectJournal } from './codex-host-effect-journal.mjs';

const excludedPath = (path, excluded) => excluded.some(entry => {
  const normalized = String(entry).replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  return normalized && (path === normalized || path.startsWith(`${normalized}/`)
    || (!normalized.includes('/') && path.split('/').includes(normalized)));
});

export const assessPlanSourceCompatibility = ({ planRun, baselineSnapshot, currentSnapshot, excluded = [] }) => {
  assert(baselineSnapshot?.digest === planRun.sourceDigest, 'PLAN_SOURCE_BASELINE_MISMATCH', 'Plan source evidence does not match its Authority snapshot.');
  const plan = planApprovalSnapshot(planRun);
  assert(plan?.reviewApproved, 'PLAN_SOURCE_REVIEW_REQUIRED', 'Source compatibility requires an independently reviewed plan.');
  const baseline = { ...baselineSnapshot, files: baselineSnapshot.files.filter(file => !excludedPath(file.path, excluded)) };
  const changedFiles = diffWorkspaceSnapshots(baseline, currentSnapshot);
  return {
    projectId: plan.projectId, runId: plan.runId, planDigest: plan.planDigest, artifactDigest: plan.artifactDigest,
    fromSourceDigest: planRun.sourceDigest, toSourceDigest: currentSnapshot.digest,
    changedFilesDigest: digestJson(changedFiles), changedFiles,
  };
};

export const planSourceCompatibilityDecisionId = assessment => `implementation-plan-source-compatible/${assessment.toSourceDigest}`;

export const matchingPlanSourceCompatibilityDecision = (planRun, assessment) => (planRun.decisions ?? []).find(decision =>
  (decision.id === 'implementation-plan-source-compatible' || decision.id === planSourceCompatibilityDecisionId(assessment))
  && decision.decision === 'approved' && decision.actor
  && decision.projectId === assessment.projectId && decision.runId === assessment.runId
  && decision.planDigest === assessment.planDigest && decision.artifactDigest === assessment.artifactDigest
  && decision.fromSourceDigest === assessment.fromSourceDigest && decision.toSourceDigest === assessment.toSourceDigest
  && decision.changedFilesDigest === assessment.changedFilesDigest) ?? null;

export const planSourceCompatibilitySatisfied = (planRun, assessment) =>
  Boolean(matchingPlanSourceCompatibilityDecision(planRun, assessment));

const safePath = value => typeof value === 'string' && value.length > 0
  && !value.includes('\\') && !value.includes(':') && !value.startsWith('/')
  && value.split('/').every(segment => segment && segment !== '.' && segment !== '..' && !segment.includes('*'));
const containsPath = (scope, path) => path === scope || path.startsWith(`${scope}/`);

export const assessAutomaticPlanSourceCompatibility = ({ planRun, assessment, implementationFeatures, policyPaths }) => {
  assert(Array.isArray(policyPaths) && policyPaths.every(safePath), 'PLAN_SOURCE_AUTO_PATH_INVALID', 'Automatic plan source paths must be safe project-relative paths.');
  const proposal = reviewedPlanProposal(planRun);
  const approvedPaths = (proposal?.proposedFeatures ?? [])
    .filter(feature => feature.projectId === planRun.projectId && feature.disposition === 'project-owned')
    .flatMap(feature => feature.allowedPaths ?? []).filter(safePath);
  const implementationPaths = (implementationFeatures ?? [])
    .filter(feature => feature.metadata?.stage === 'implementation' && feature.metadata?.sourcePolicy !== 'read-only')
    .flatMap(feature => feature.allowedPaths ?? []).filter(safePath);
  if (!assessment.changedFiles.length || !policyPaths.length || !approvedPaths.length || !implementationPaths.length) return null;
  if (!assessment.changedFiles.every(path => safePath(path)
    && policyPaths.some(scope => containsPath(scope, path))
    && approvedPaths.some(scope => containsPath(scope, path))
    && implementationPaths.some(scope => containsPath(scope, path)))) return null;
  return {
    mode: 'approved-plan-policy-paths',
    fromSourceDigest: assessment.fromSourceDigest,
    toSourceDigest: assessment.toSourceDigest,
    changedFilesDigest: assessment.changedFilesDigest,
    changedFiles: [...assessment.changedFiles],
    policyPathsDigest: digestJson(policyPaths),
  };
};

/** Preserve source progress already committed by an implementation Run for this exact approved plan. */
export const assessVerifiedImplementationContinuation = ({ planRun, planArtifact, priorRuns, currentSourceDigest, workspaceRoot, implementationFeatures }) => {
  const currentPaths = (implementationFeatures ?? [])
    .filter(feature => feature.metadata?.stage === 'implementation' && feature.metadata?.sourcePolicy !== 'read-only')
    .flatMap(feature => feature.allowedPaths ?? []).filter(safePath);
  if (!currentPaths.length) return null;
  const sameRoot = value => typeof value === 'string' && (process.platform === 'win32'
    ? resolve(value).toLowerCase() === resolve(workspaceRoot).toLowerCase()
    : resolve(value) === resolve(workspaceRoot));
  for (const run of priorRuns ?? []) {
    const binding = run.metadata?.approvedPlan;
    if (run.projectId !== planRun.projectId || run.metadata?.commandIntent?.action !== 'implement'
      || run.metadata.commandIntent.target !== planRun.metadata?.commandIntent?.target
      || run.metadata?.workflow?.id !== planRun.metadata?.workflow?.id
      || !sameRoot(run.metadata?.workspace?.root) || run.sourceDigest !== currentSourceDigest
      || run.leases?.some(lease => lease.status === 'active')
      || run.dispatches?.some(dispatch => ['requested', 'bound'].includes(dispatch.status))
      || binding?.runId !== planRun.runId || binding.planDigest !== planArtifact.planDigest
      || binding.artifactDigest !== planArtifact.artifactDigest
      || binding.originalSourceDigest !== planRun.sourceDigest || !binding.sourceDigest) continue;
    const submitted = (run.submissions ?? []).filter(item => !item.supersededAt);
    if (!submitted.length || !submitted.some(item => item.changedFiles?.length)) continue;
    let digest = binding.sourceDigest;
    let valid = true;
    for (const item of submitted) {
      const feature = run.features?.find(candidate => candidate.id === item.featureId);
      const paths = item.changedFiles ?? [];
      if (item.inputSourceDigest !== digest || !item.outputSourceDigest || !item.submissionDigest
        || !item.evidenceRefs?.length || !feature
        || !paths.every(path => safePath(path)
          && feature.allowedPaths?.some(scope => safePath(scope) && containsPath(scope, path))
          && currentPaths.some(scope => containsPath(scope, path)))) { valid = false; break; }
      digest = item.outputSourceDigest;
    }
    if (valid && digest === currentSourceDigest && digest !== binding.sourceDigest) return {
      mode: 'verified-prior-implementation', priorRunId: run.runId,
      fromSourceDigest: binding.sourceDigest, toSourceDigest: currentSourceDigest,
      submissionDigests: submitted.map(item => item.submissionDigest),
    };
  }
  return null;
};

/** Carry an abandoned Dispatch's in-scope source delta as unverified work for a new Run. */
export const assessRecoveredImplementationContinuation = async ({ planRun, planArtifact, priorRuns, currentSnapshot,
  workspaceRoot, implementationFeatures, evidenceStore, controlRoot, dataRoot, readHostEffect = null }) => {
  const approvedPaths = (reviewedPlanProposal(planRun)?.proposedFeatures ?? [])
    .filter(feature => feature.projectId === planRun.projectId && feature.disposition === 'project-owned')
    .flatMap(feature => feature.allowedPaths ?? []).filter(safePath);
  const implementationPaths = (implementationFeatures ?? [])
    .filter(feature => feature.metadata?.stage === 'implementation' && feature.metadata?.sourcePolicy !== 'read-only')
    .flatMap(feature => feature.allowedPaths ?? []).filter(safePath);
  for (const run of priorRuns ?? []) {
    if (run.status !== 'superseded' || !/^development-h[23]-recovery:[a-f0-9]{64}$/.test(run.metadata?.supersededReason ?? '')) continue;
    const verified = assessVerifiedImplementationContinuation({ planRun, planArtifact, priorRuns: [run],
      currentSourceDigest: run.sourceDigest, workspaceRoot, implementationFeatures });
    if (!verified) continue;
    const abandoned = run.dispatches.filter(dispatch => dispatch.status === 'superseded'
      && dispatch.sourceDigest === run.sourceDigest && dispatch.sourceSnapshotRef
      && !run.submissions.some(submission => submission.dispatchId === dispatch.dispatchId));
    if (abandoned.length !== 1) continue;
    const dispatch = abandoned[0];
    const lease = run.leases.find(item => item.dispatchId === dispatch.dispatchId && item.status === 'superseded');
    const feature = run.features.find(item => item.id === dispatch.featureId && item.metadata?.stage === 'implementation');
    const spawn = lease?.runtimeReceipt?.hostSpawnReceipt;
    if (!lease || !feature || !spawn?.effectId || !spawn.contract) continue;
    const effect = readHostEffect
      ? await readHostEffect(spawn.effectId, spawn.contract)
      : await new CodexHostEffectJournal({ controlRoot, dataRoot, contract: spawn.contract }).read(spawn.effectId, { required: true });
    if (effect.state !== 'contained' || effect.outcome?.reason !== 'development-run-recovery'
      || !['absent-after-interrupt', 'interrupted', 'already-terminal'].includes(effect.outcome.disposition)
      || effect.canonicalAgentName !== lease.agentId || effect.binding?.projectId !== run.projectId
      || effect.binding.runId !== run.runId || effect.binding.dispatchId !== dispatch.dispatchId
      || effect.binding.packetDigest !== dispatch.packetDigest
      || effect.binding.promptDigest !== lease.runtimeReceipt?.prompt?.promptDigest) continue;
    const evidence = await evidenceStore.read(dispatch.sourceSnapshotRef);
    if (evidence.metadata?.projectId !== run.projectId || evidence.metadata?.runId !== run.runId) continue;
    const baseline = JSON.parse(evidence.bytes.toString('utf8'));
    if (baseline.digest !== dispatch.sourceDigest) continue;
    const changedFiles = diffWorkspaceSnapshots(baseline, currentSnapshot);
    if (!changedFiles.length || !changedFiles.every(path => safePath(path)
      && feature.allowedPaths?.some(scope => safePath(scope) && containsPath(scope, path))
      && approvedPaths.some(scope => containsPath(scope, path))
      && implementationPaths.some(scope => containsPath(scope, path)))) continue;
    return { mode: 'verified-prior-implementation-with-abandoned-dispatch', priorRunId: run.runId,
      fromSourceDigest: verified.fromSourceDigest, toSourceDigest: currentSnapshot.digest,
      submissionDigests: verified.submissionDigests, abandonedDispatchId: dispatch.dispatchId,
      hostEffectDigest: effect.effectDigest, changedFilesDigest: digestJson(changedFiles), changedFiles };
  }
  return null;
};
