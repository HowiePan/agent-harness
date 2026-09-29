import { digestJson } from '../common/canonical.mjs';
import { assert } from '../common/errors.mjs';
import { diffWorkspaceSnapshots } from '../common/workspace-snapshot.mjs';
import { planApprovalSnapshot } from '../flows/delivery-lifecycle/plan-approval.mjs';

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

export const planSourceCompatibilitySatisfied = (planRun, assessment) => (planRun.decisions ?? []).some(decision =>
  decision.id === 'implementation-plan-source-compatible' && decision.decision === 'approved' && decision.actor
  && decision.projectId === assessment.projectId && decision.runId === assessment.runId
  && decision.planDigest === assessment.planDigest && decision.artifactDigest === assessment.artifactDigest
  && decision.fromSourceDigest === assessment.fromSourceDigest && decision.toSourceDigest === assessment.toSourceDigest
  && decision.changedFilesDigest === assessment.changedFilesDigest);
