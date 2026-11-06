// Elapsed duration is a diagnostic signal, never a terminal verdict.
export const executionHealth = ({ state = 'running', userStopped = false, resourceViolation = null,
  observationFresh = true, startedAt, observedAt, progress = [], reviewAfterMs = 300000 }) => {
  if (userStopped) return { action: 'stop', reason: 'user-stop' };
  if (resourceViolation) return { action: 'stop', reason: 'resource-violation' };
  if (['failed', 'blocked'].includes(state)) return { action: 'recover', reason: 'observed-terminal-failure' };
  if (state === 'completed') return { action: 'complete', reason: 'observed-terminal-result' };
  if (!observationFresh) return { action: 'diagnose', reason: 'observation-unavailable' };
  const kinds = new Set(['source-change', 'build-stage', 'test-result', 'checkpoint']);
  let last = startedAt, verified = false;
  for (const item of progress) if (item.hostVerified === true && kinds.has(item.kind)
    && typeof item.evidenceRef === 'string' && item.evidenceRef.length > 0
    && Number.isFinite(item.at) && item.at >= startedAt && item.at <= observedAt) {
    last = Math.max(last, item.at); verified = true;
  }
  return observedAt - last >= reviewAfterMs
    ? { action: 'diagnose', reason: 'no-recent-verified-progress' }
    : { action: 'observe', reason: verified ? 'verified-progress' : 'observable-process' };
};
