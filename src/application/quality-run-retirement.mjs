import { assert } from '../common/errors.mjs';

const unrecoverablePlanCodes = new Set([
  'LIFECYCLE_RESUME_EXTENSION_MISMATCH',
  'LIFECYCLE_RESUME_IDENTITY_STALE',
  'LIFECYCLE_RESUME_PLAN_MISMATCH',
  'LIFECYCLE_RESUME_FEATURE_MISMATCH',
]);

export const retireUnresumableQualityRun = async ({ harness, state, error, commandId, dryRun = false }) => {
  if (state?.metadata?.commandIntent?.action !== 'quality' || !unrecoverablePlanCodes.has(error?.code)) return null;
  assert(!state.leases.some(lease => lease.status === 'active')
    && !state.dispatches.some(dispatch => ['requested', 'assigned'].includes(dispatch.status)),
  'QUALITY_FAILURE_ACTIVE_EFFECT', 'An unresumable quality Run still has an active Agent or Dispatch.');
  const current = await harness.authorityStore.read(state.projectId, state.runId);
  assert(current.revision === state.revision && current.authorityDigest === state.authorityDigest,
    'QUALITY_FAILURE_AUTHORITY_STALE', 'Quality Run Authority changed during failure assessment.');
  if (dryRun) return { runId: state.runId, status: 'failed', reason: error.code };
  const evidence = await harness.evidenceStore.put({
    kind: 'quality-continuation-failure', runId: state.runId, authorityDigest: state.authorityDigest,
    planDigest: state.metadata.lifecyclePlanDigest, code: error.code, message: error.message,
  }, {
    mediaType: 'application/json', projectId: state.projectId, runId: state.runId,
    epoch: state.epoch, generation: state.generation, sourceDigest: state.sourceDigest,
    artifactDigest: state.artifactDigest, policyDigest: state.policyDigest,
    pluginSetDigest: state.pluginSetDigest, labels: ['quality-continuation-failure'],
  });
  return harness.kernel.finishRun(state.projectId, state.runId,
    { status: 'failed', reason: error.code, evidenceRefs: [evidence.ref] },
    { expectedRevision: state.revision, commandId: `${commandId}.quality-prior-failed` });
};
