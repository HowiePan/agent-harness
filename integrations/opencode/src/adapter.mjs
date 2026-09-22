import { createVisibleHostAdapter } from '../../../src/platform/plugins/runtime/visible-host-adapter.mjs';
import { assert } from '../../../src/common/errors.mjs';

export const OPENCODE_HOST_PROVIDER = 'opencode-host';

const requireCapability = (value, name) => {
  assert(typeof value === 'function', 'OPENCODE_VISIBLE_HOST_CAPABILITIES_REQUIRED', `OpenCode visible execution requires native ${name}.`);
  return value;
};

/** Bind a verified OpenCode host without emulating any native lifecycle state. */
export const createOpenCodeVisibleHostAdapter = ({
  spawnTask,
  inspectTask,
  waitTask,
  resultTask,
  cancelTask,
  reconcileHostEffects,
  confirmLease,
  adapterVersion = '1.0.0',
} = {}) => {
  const nativeSpawn = requireCapability(spawnTask, 'spawnTask');
  const nativeInspect = requireCapability(inspectTask, 'inspectTask');
  const nativeWait = requireCapability(waitTask, 'waitTask');
  const nativeResult = requireCapability(resultTask, 'resultTask');
  const nativeCancel = requireCapability(cancelTask, 'cancelTask');
  const nativeReconcile = requireCapability(reconcileHostEffects, 'reconcileHostEffects');
  const nativeConfirm = requireCapability(confirmLease, 'confirmLease');

  return createVisibleHostAdapter({
    provider: OPENCODE_HOST_PROVIDER,
    adapterVersion,
    spawnVisibleAgent: async input => {
      const result = await nativeSpawn(structuredClone(input));
      assert(result?.agentId && result.visibility?.mode === 'user-visible' && result.visibility?.surface && result.visibility?.inspectRef && result.hostSpawnReceipt, 'OPENCODE_NATIVE_SPAWN_RECEIPT_INVALID', 'OpenCode native spawn must return an inspectable user-visible task and bound spawn receipt.');
      return result;
    },
    inspectVisibleAgent: async expected => nativeInspect(structuredClone(expected)),
    waitVisibleAgent: async input => nativeWait(structuredClone(input)),
    readVisibleResult: async input => nativeResult(structuredClone(input)),
    containVisibleAgent: async input => {
      const receipt = await nativeCancel(structuredClone(input));
      assert(receipt?.contained === true, 'OPENCODE_NATIVE_CONTAINMENT_UNVERIFIED', 'OpenCode native containment must return a verified containment receipt.');
      return receipt;
    },
    reconcileVisibleHostEffects: async input => {
      const receipt = await nativeReconcile(structuredClone(input));
      assert(receipt?.reconciled === true && receipt.ready === true, 'OPENCODE_NATIVE_RECONCILIATION_UNVERIFIED', 'OpenCode native host-effect reconciliation must prove readiness.');
      return receipt;
    },
    confirmVisibleLease: async input => {
      const receipt = await nativeConfirm(structuredClone(input));
      assert(receipt?.confirmed === true, 'OPENCODE_NATIVE_LEASE_CONFIRMATION_UNVERIFIED', 'OpenCode native Lease confirmation must be verified.');
      return receipt;
    },
  });
};
