import { assert } from '../common/errors.mjs';

const planningActions = new Set(['requirements', 'plan', 'replan']);
const versionPattern = /^V\d+\.\d+\.\d+$/;
const before = (left, right) => {
  const a = left.slice(1).split('.').map(BigInt);
  const b = right.slice(1).split('.').map(BigInt);
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
};

/** Require an explicit lineage edge and independently published release evidence. */
export const verifyPlanningPredecessor = async ({ project, intent, readVersionRelease }) => {
  if (!planningActions.has(intent.action) || !versionPattern.test(intent.target ?? '')) return null;
  const predecessors = project.policy?.versionPredecessors;
  if (!predecessors) return null;
  const previous = predecessors?.[intent.target];
  assert(typeof previous === 'string' && versionPattern.test(previous) && before(previous, intent.target),
    'PLANNING_PREDECESSOR_UNDECLARED', `Project must declare the predecessor of ${intent.target} before ${intent.action}.`);
  const release = await readVersionRelease(project.id, previous);
  assert(release?.state?.status === 'released' && release.formalReleaseStatus === 'git-published',
    'PLANNING_PREDECESSOR_NOT_RELEASED', `${intent.action} ${intent.target} requires a verified Git-published release of ${previous}.`,
    { target: intent.target, predecessor: previous, status: release?.formalReleaseStatus ?? 'unknown' });
  return { target: intent.target, predecessor: previous, publication: release.state.publication };
};
