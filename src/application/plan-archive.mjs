import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assert } from '../common/errors.mjs';
import { sha256 } from '../common/canonical.mjs';
import { atomicWrite } from '../kernel/atomic-io.mjs';
import { planApprovalSnapshot } from '../flows/delivery-lifecycle/plan-approval.mjs';

const targetPattern = /^V(\d+)\.\d+\.\d+$/;

export const planArchivePath = (project, target) => {
  const root = project.policy?.planArchiveRoot;
  if (!root) return null;
  const match = targetPattern.exec(target ?? '');
  assert(match && typeof root === 'string' && root.split('/').every(part => part && part !== '.' && part !== '..')
    && !root.includes('\\') && !root.includes(':') && !root.startsWith('/'),
  'PLAN_ARCHIVE_CONFIG_INVALID', 'Plan archive requires a safe project-relative root and SemVer target.');
  return `${root}/v${match[1]}/${target.toLowerCase()}-execution-plan-review.md`;
};

/** Publish the reviewed Markdown byte-for-byte; never overwrite a different project file. */
export const ensureProjectPlanArchive = async ({ project, state, workspaceRoot, previousPlanRuns = [], dryRun = false }) => {
  const snapshot = planApprovalSnapshot(state);
  if (!snapshot?.reviewApproved) return null;
  const relativePath = planArchivePath(project, snapshot.target);
  if (!relativePath) return null;
  const path = resolve(workspaceRoot, relativePath);
  let existing = null;
  try { existing = await readFile(path, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const priorGenerated = previousPlanRuns.some(run => {
    const prior = planApprovalSnapshot(run);
    return run.projectId === state.projectId && prior?.reviewApproved && prior.target === snapshot.target
      && [prior.artifactDigest, planApprovalSnapshot(run, { legacyStructuredValues: true }).artifactDigest]
        .includes(sha256(existing ?? ''));
  });
  assert(existing === null || existing === snapshot.markdown || priorGenerated, 'PLAN_ARCHIVE_CONFLICT',
    `Project plan archive ${relativePath} differs from the reviewed plan; preserve it and resolve the conflict explicitly.`);
  if (!dryRun && existing !== snapshot.markdown) await atomicWrite(path, snapshot.markdown, { root: workspaceRoot });
  return { relativePath, path, planDigest: snapshot.planDigest, artifactDigest: snapshot.artifactDigest,
    ...(dryRun ? { updateRequired: existing !== snapshot.markdown } : {}) };
};

/** Admit only the exact generated archive delta, with all other source files unchanged. */
export const assessPlanArchiveSourceCompatibility = ({ project, planRun, assessment, currentSnapshot }) => {
  const snapshot = planApprovalSnapshot(planRun);
  if (!snapshot?.reviewApproved) return null;
  const path = planArchivePath(project, snapshot.target);
  if (!path || assessment.changedFiles.length !== 1 || assessment.changedFiles[0] !== path) return null;
  const current = currentSnapshot.files.find(file => file.path === path);
  if (current?.sha256 !== snapshot.artifactDigest || current.size !== Buffer.byteLength(snapshot.markdown)) return null;
  return { mode: 'verified-plan-archive', path, planDigest: snapshot.planDigest,
    artifactDigest: snapshot.artifactDigest, fromSourceDigest: assessment.fromSourceDigest,
    toSourceDigest: assessment.toSourceDigest, changedFilesDigest: assessment.changedFilesDigest };
};
