/** Progress is project-owned implementation work, never an authority/external bypass. */
export const permitsImplementationProgress = (feature, result) => feature?.metadata?.stage === 'implementation'
  && result?.status === 'blocked'
  && (!/(?:permission|authority|out-of-scope|scope-violation|policy|forbidden|external|approval|security|host|environment|dependency)/i
    .test(`${result.failureClass ?? ''} ${result.blocker?.kind ?? ''}`)
    || result.failureClass === 'external-prerequisite-and-incomplete-implementation');

export const implementationAttemptBudget = ({ state, feature, result }) => {
  if (state.metadata?.attemptAccounting !== 'separate-progress-v1' || feature.metadata?.stage !== 'implementation') return null;
  const retries = feature.metadata.implementationProgressRetries;
  return { kind: permitsImplementationProgress(feature, result) && Number.isSafeInteger(retries) && retries > 0 ? 'progress' : 'failure',
    limit: retries + 1, failureLimit: Math.min(feature.attemptLimit, 3) };
};
