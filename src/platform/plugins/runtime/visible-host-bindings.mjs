import { assert } from '../../../common/errors.mjs';
import { createVisibleHostAdapter, isVisibleHostAdapter } from './visible-host-adapter.mjs';

const runtimeIdPattern = /^[a-z0-9][a-z0-9.-]+$/;

const normalizeAdapter = adapter => {
  if (adapter === null || adapter === undefined) return null;
  if (isVisibleHostAdapter(adapter)) return adapter;
  if (typeof adapter?.inspectVisibleAgent === 'function') return createVisibleHostAdapter(adapter);
  assert(false, 'VISIBLE_AGENT_HOST_ADAPTER_REQUIRED', 'Visible Agent host callbacks must be wrapped by createVisibleHostAdapter().');
};

/** Host-owned capabilities are bound to exact Runtime IDs, never selected by provider name. */
export const createVisibleHostBindings = ({ agentAdapter = null, agentAdapters = {} } = {}) => {
  assert(agentAdapters instanceof Map || (agentAdapters && typeof agentAdapters === 'object' && !Array.isArray(agentAdapters) && [Object.prototype, null].includes(Object.getPrototypeOf(agentAdapters))), 'VISIBLE_HOST_BINDINGS_INVALID', 'Visible host bindings must be a Runtime-ID keyed object or Map.');
  const entries = agentAdapters instanceof Map ? [...agentAdapters] : Object.entries(agentAdapters);
  assert(!(agentAdapter && entries.length), 'VISIBLE_HOST_BINDINGS_AMBIGUOUS', 'Use either the legacy agentAdapter or Runtime-ID keyed agentAdapters.');
  const legacy = normalizeAdapter(agentAdapter);
  const bindings = new Map();
  for (const [runtimePluginId, candidate] of entries) {
    assert(typeof runtimePluginId === 'string' && runtimeIdPattern.test(runtimePluginId), 'VISIBLE_HOST_RUNTIME_ID_INVALID', 'Visible host binding requires a valid Runtime plugin ID.');
    assert(!bindings.has(runtimePluginId), 'VISIBLE_HOST_RUNTIME_DUPLICATE', `Visible host Runtime is bound more than once: ${runtimePluginId}.`);
    const adapter = normalizeAdapter(candidate);
    assert(adapter, 'VISIBLE_AGENT_HOST_ADAPTER_REQUIRED', `Visible host Runtime ${runtimePluginId} requires a trusted adapter.`);
    bindings.set(runtimePluginId, adapter);
  }
  return Object.freeze({
    runtimePluginIds: Object.freeze([...bindings.keys()].sort()),
    resolve: runtimePluginId => bindings.get(runtimePluginId) ?? legacy,
    assertInstalled: pluginHost => {
      for (const runtimePluginId of bindings.keys()) {
        const manifest = pluginHost.get(runtimePluginId, 'agent-runtime').manifest;
        assert(manifest.capabilities.includes('host-orchestrated') && manifest.capabilities.includes('user-visible'), 'VISIBLE_HOST_RUNTIME_INCOMPATIBLE', `Runtime ${runtimePluginId} cannot use a visible host adapter.`);
      }
    },
  });
};

export const assertVisibleHostReceiptOwner = (adapter, runtimeReceipt) => {
  const prior = runtimeReceipt?.hostAttestation;
  assert(prior?.provider === adapter?.provider && prior?.adapterVersion === adapter?.adapterVersion, 'VISIBLE_HOST_RECEIPT_OWNER_MISMATCH', 'Active visible Lease belongs to a different host adapter identity.');
  return prior;
};
