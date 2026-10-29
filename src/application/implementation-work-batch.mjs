import { digestJson } from '../common/canonical.mjs';

const pathsFor = obligation => [...new Set([
  ...(obligation.finalPaths ?? []),
  ...(obligation.nativeDependencies ?? []).map(item => item.targetPath),
])].filter(path => typeof path === 'string' && path.length > 0);

/** A work aid derived from the approved graph, never new scope or acceptance. */
export const buildImplementationWorkBatch = ({ obligations, steps, next, verified, closedIds, history,
  isAllowedPath = path => steps.some(step => step.targetPath === path) }) => {
  const open = obligations.filter(item => !closedIds.has(item.id));
  const byPath = new Map(steps.map(step => [step.targetPath, step]));
  // Existing target checkpoints are only a reason to try the real certificate.
  // Missing or out-of-scope dependencies must not silently disappear here.
  const certificateCandidates = open.filter(item => item.kind === 'aggregate-certificate'
    && pathsFor(item).length > 0
    && pathsFor(item).every(path => byPath.has(path) && verified(byPath.get(path))));
  const selectedPaths = new Set(next ? [next.targetPath] : pathsFor(certificateCandidates[0] ?? {}));
  const selectedIds = new Set();
  let expanded;
  do {
    expanded = false;
    for (const item of open) {
      const paths = pathsFor(item);
      if (selectedIds.has(item.id) || !paths.some(path => selectedPaths.has(path))) continue;
      selectedIds.add(item.id);
      for (const path of paths) selectedPaths.add(path);
      expanded = true;
    }
  } while (expanded);
  const targets = steps.filter(step => selectedPaths.has(step.targetPath));
  let consecutiveDevelopmentHandoffs = 0;
  for (const item of [...history].reverse()) {
    if (item.result?.status !== 'blocked') break;
    const closesObligation = (item.result.checkpoints ?? []).some(checkpoint =>
      obligations.some(obligation => obligation.id === checkpoint.id)
      && checkpoint.status === 'completed' && checkpoint.evidence?.length > 0);
    if (closesObligation) break;
    consecutiveDevelopmentHandoffs++;
  }
  return {
    id: `implementation-work-batch:${digestJson({ paths: [...selectedPaths], obligations: [...selectedIds] })}`,
    policy: 'connected-approved-obligations/1',
    targetStepIds: targets.map(step => step.id),
    pendingTargetStepIds: targets.filter(step => !verified(step)).map(step => step.id),
    obligationIds: [...selectedIds],
    supportingPaths: [...selectedPaths].filter(path => !byPath.has(path) && isAllowedPath(path)),
    unavailableDependencyPaths: [...selectedPaths].filter(path => !isAllowedPath(path)),
    certificateCandidateIds: certificateCandidates.map(item => item.id),
    consecutiveDevelopmentHandoffs,
    acceptanceStatus: 'unverified-candidates-only',
  };
};
