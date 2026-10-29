import { assert } from '../common/errors.mjs';

/** A live deterministic verifier still owns its result Lease until commit. */
export const withVerificationLease = async ({ kernel, authorityStore, state, lease, commandId, intervalMs = 30000 }, operation) => {
  let sequence = 0;
  let pending = Promise.resolve();
  let failure = null;
  const pulse = async () => {
    const current = await authorityStore.read(state.projectId, state.runId);
    assert(current.epoch === state.epoch && current.generation === state.generation,
      'DELIVERY_VERIFICATION_EPOCH_CHANGED', 'Verification cannot renew a superseded transport.');
    await kernel.heartbeat(state.projectId, state.runId, { leaseId: lease.leaseId, agentId: lease.agentId,
      progress: 'delivery-verification' }, { expectedRevision: current.revision, commandId: `${commandId}.verification-heartbeat.${sequence++}` });
  };
  await pulse();
  const timer = setInterval(() => { pending = pending.then(pulse).catch(error => { failure ??= error; }); }, intervalMs);
  try { return await operation(); }
  finally { clearInterval(timer); await pending; if (failure) throw failure; }
};
