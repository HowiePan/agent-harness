import { assert } from '../../errors.mjs';

const semanticVersion = /^\d+\.\d+\.\d+$/;
const visibleHostAdapterBrand = Symbol('agent-harness.visible-host-adapter');
export const isVisibleHostAdapter = value => value?.[visibleHostAdapterBrand] === true;
const nonEmpty = (value, code, message) => {
  assert(typeof value === 'string' && value.length > 0, code, message);
  return value;
};

const unsupported = operation => async () => {
  const error = new Error(`Visible Agent host adapter does not expose Runtime operation: ${operation}.`);
  error.code = 'VISIBLE_AGENT_HOST_OPERATION_UNAVAILABLE';
  throw error;
};

const assertObservation = (observation, expected) => {
  assert(observation?.verified === true, 'VISIBLE_AGENT_HOST_OBSERVATION_UNVERIFIED', 'The host did not return a verified visible-Agent observation.');
  assert(['queued', 'running', 'completed', 'failed', 'blocked'].includes(observation.status), 'VISIBLE_AGENT_HOST_STATUS_INVALID', 'The visible-Agent observation must expose an observable lifecycle status.');
  assert(observation.agentId === expected.agentId, 'VISIBLE_AGENT_HOST_AGENT_MISMATCH', 'Visible-Agent observation is bound to a different Agent.');
  assert(observation.dispatchId === expected.dispatchId, 'VISIBLE_AGENT_HOST_DISPATCH_MISMATCH', 'Visible-Agent observation is bound to a different Dispatch.');
  assert(observation.packetDigest === expected.packetDigest, 'VISIBLE_AGENT_HOST_PACKET_MISMATCH', 'Visible-Agent observation is bound to a different Dispatch packet.');
  assert(observation.promptDigest === expected.promptDigest, 'VISIBLE_AGENT_HOST_PROMPT_MISMATCH', 'Visible-Agent observation is bound to a different generated Prompt.');
  assert(observation.visibility?.mode === 'user-visible', 'VISIBLE_AGENT_HOST_VISIBILITY_INVALID', 'Visible-Agent observation must identify a user-visible host surface.');
  assert(observation.visibility.surface === expected.surface, 'VISIBLE_AGENT_HOST_SURFACE_MISMATCH', 'Visible-Agent observation is bound to a different host surface.');
  assert(observation.visibility.inspectRef === expected.inspectRef, 'VISIBLE_AGENT_HOST_INSPECT_REF_MISMATCH', 'Visible-Agent observation is bound to a different inspectable task reference.');
  nonEmpty(observation.assertionId, 'VISIBLE_AGENT_HOST_ASSERTION_REQUIRED', 'Visible-Agent observation must include a host assertion identifier.');
  assert(typeof observation.observedAt === 'string' && !Number.isNaN(Date.parse(observation.observedAt)), 'VISIBLE_AGENT_HOST_OBSERVED_AT_REQUIRED', 'Visible-Agent observation must include a valid observation timestamp.');
  return observation;
};

export const assertFreshVisibleObservation = (observation, { now = () => new Date().toISOString(), timeoutMs = 120000 } = {}) => {
  assert(Number.isFinite(timeoutMs) && timeoutMs > 0, 'VISIBLE_AGENT_HOST_TIMEOUT_INVALID', 'Visible host observation timeout must be a positive number of milliseconds.');
  const observedAt = Date.parse(observation?.observedAt ?? '');
  const nowAt = Date.parse(typeof now === 'function' ? now() : now);
  assert(Number.isFinite(observedAt) && Number.isFinite(nowAt), 'VISIBLE_AGENT_HOST_OBSERVED_AT_REQUIRED', 'Visible host observation requires valid timestamps.');
  const age = nowAt - observedAt;
  assert(age >= -5000, 'VISIBLE_AGENT_HOST_OBSERVED_AT_FUTURE', 'Visible host observation timestamp is too far in the future.');
  assert(age < timeoutMs, 'VISIBLE_AGENT_HOST_OBSERVATION_STALE', 'Visible host observation is stale.');
  return observation;
};

/**
 * Adapt the native interactive host's inspect operation to the Harness trust boundary.
 * The inspectVisibleAgent callback is the host-owned capability; its response is never
 * accepted as proof until every identity, digest, visibility, and inspection field is
 * checked here.
 */
export const createVisibleHostAdapter = ({ inspectVisibleAgent, spawnVisibleAgent, waitVisibleAgent, readVisibleResult, reconcileVisibleHostEffects, confirmVisibleLease, containVisibleAgent, sendVisibleAgent, interruptVisibleAgent, provider = 'interactive-host', adapterVersion = '1.0.0' } = {}) => {
  assert(typeof inspectVisibleAgent === 'function', 'VISIBLE_AGENT_HOST_INSPECTOR_REQUIRED', 'A visible host adapter requires the native host inspectVisibleAgent capability.');
  assert(typeof provider === 'string' && provider.length > 0, 'VISIBLE_AGENT_HOST_PROVIDER_REQUIRED', 'A visible host adapter requires a provider identity.');
  assert(semanticVersion.test(adapterVersion), 'VISIBLE_AGENT_HOST_ADAPTER_VERSION_INVALID', 'A visible host adapter requires a semantic adapter version.');

  const observe = async ({ dispatch, prompt, agentId, runtimeReceipt }) => {
    const expected = {
      agentId: nonEmpty(agentId, 'VISIBLE_AGENT_HOST_AGENT_ID_REQUIRED', 'Visible host observation requires an Agent identity.'),
      dispatchId: nonEmpty(dispatch?.dispatchId, 'VISIBLE_AGENT_HOST_DISPATCH_ID_REQUIRED', 'Visible host observation requires a Dispatch identity.'),
      packetDigest: nonEmpty(dispatch?.packetDigest, 'VISIBLE_AGENT_HOST_PACKET_DIGEST_REQUIRED', 'Visible host observation requires a packet digest.'),
      promptDigest: nonEmpty(prompt?.promptDigest, 'VISIBLE_AGENT_HOST_PROMPT_DIGEST_REQUIRED', 'Visible host observation requires a Prompt digest.'),
      surface: nonEmpty(runtimeReceipt?.visibility?.surface, 'VISIBLE_AGENT_HOST_SURFACE_REQUIRED', 'Visible host observation requires a host surface.'),
      inspectRef: nonEmpty(runtimeReceipt?.visibility?.inspectRef, 'VISIBLE_AGENT_HOST_INSPECT_REF_REQUIRED', 'Visible host observation requires an inspectable task reference.'),
    };
    const observation = await inspectVisibleAgent({
      ...expected,
      hostSpawnReceipt: structuredClone(runtimeReceipt?.hostSpawnReceipt ?? null),
    });
    return assertObservation(observation, expected);
  };

  return Object.freeze({
    [visibleHostAdapterBrand]: true,
    provider,
    adapterVersion,
    capabilities: Object.freeze({
      inspect: true,
      spawn: typeof spawnVisibleAgent === 'function',
      wait: typeof waitVisibleAgent === 'function',
      result: typeof readVisibleResult === 'function',
      reconcile: typeof reconcileVisibleHostEffects === 'function',
      confirm: typeof confirmVisibleLease === 'function',
      contain: typeof containVisibleAgent === 'function',
      send: typeof sendVisibleAgent === 'function',
      interrupt: typeof interruptVisibleAgent === 'function',
    }),
    verifyVisibleLease: async input => {
      const observation = await observe(input);
      return {
        verified: true,
        provider,
        adapterVersion,
        assertionId: observation.assertionId,
        observedAt: observation.observedAt,
        agentId: observation.agentId,
        dispatchId: observation.dispatchId,
        packetDigest: observation.packetDigest,
        promptDigest: observation.promptDigest,
        visibility: structuredClone(observation.visibility),
      };
    },
    heartbeatVisibleAgent: async input => {
      const observation = await observe(input);
      return {
        verified: true,
        provider,
        adapterVersion,
        assertionId: observation.assertionId,
        observedAt: observation.observedAt,
        agentId: observation.agentId,
        dispatchId: observation.dispatchId,
        packetDigest: observation.packetDigest,
        promptDigest: observation.promptDigest,
        visibility: structuredClone(observation.visibility),
        status: observation.status,
        progress: observation.progress ?? null,
      };
    },
    spawn: typeof spawnVisibleAgent === 'function' ? spawnVisibleAgent : unsupported('spawn'),
    wait: typeof waitVisibleAgent === 'function' ? waitVisibleAgent : unsupported('wait'),
    result: typeof readVisibleResult === 'function' ? readVisibleResult : unsupported('result'),
    reconcile: typeof reconcileVisibleHostEffects === 'function' ? reconcileVisibleHostEffects : unsupported('reconcile'),
    confirm: typeof confirmVisibleLease === 'function' ? confirmVisibleLease : unsupported('confirm'),
    contain: typeof containVisibleAgent === 'function' ? containVisibleAgent : unsupported('contain'),
    send: typeof sendVisibleAgent === 'function' ? sendVisibleAgent : unsupported('send'),
    heartbeat: unsupported('heartbeat'),
    interrupt: typeof interruptVisibleAgent === 'function' ? interruptVisibleAgent : unsupported('interrupt'),
  });
};
