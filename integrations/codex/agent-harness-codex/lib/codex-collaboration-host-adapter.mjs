import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createCodexVisibleHostAdapter } from '../../runtime/codex-runtime.mjs';
import { digestJson, sha256 } from '../../../../src/common/canonical.mjs';
import { assertJsonSchema } from '../../../../src/common/json-schema.mjs';
import { CodexHostEffectJournal } from './codex-host-effect-journal.mjs';

// The CLI provider schema is a separate, narrower wire dialect. Native visible
// Agents return the portable visible result, including typed workflow outputs.
const visibleResultSchema = JSON.parse(readFileSync(new URL('../../../../schemas/visible-agent-result.schema.json', import.meta.url), 'utf8'));

const contractBody = Object.freeze({
  id: 'codex-collaboration-native',
  version: '1.3.0',
  operations: Object.freeze({
    spawn: Object.freeze({ tool: 'collaboration.spawn_agent', result: Object.freeze(['task_name']) }),
    list: Object.freeze({
      tool: 'collaboration.list_agents',
      result: Object.freeze(['agents']),
      agent: Object.freeze(['agent_name', 'agent_status']),
      statuses: Object.freeze(['pending', 'running', 'waiting', 'idle', 'blocked', 'interrupted', 'failed', 'completed', '{failed:string}', '{completed:string}']),
    }),
    wait: Object.freeze({ tool: 'collaboration.wait_agent', result: Object.freeze(['message', 'timed_out']) }),
    interrupt: Object.freeze({ tool: 'collaboration.interrupt_agent', arguments: Object.freeze(['target']) }),
  }),
});

export const CODEX_COLLABORATION_NATIVE_CONTRACT = Object.freeze({
  id: contractBody.id,
  version: contractBody.version,
  digest: digestJson(contractBody),
});

const completedStatus = value => value && typeof value === 'object' && !Array.isArray(value) && typeof value.completed === 'string';
const failedStatus = value => value && typeof value === 'object' && !Array.isArray(value) && typeof value.failed === 'string';
const terminalNativeStatus = value => completedStatus(value) || failedStatus(value) || ['idle', 'failed', 'completed', 'interrupted'].includes(value);
const normalizedStatus = value => {
  if (completedStatus(value)) return 'completed';
  if (failedStatus(value)) return 'failed';
  if (value === 'pending') return 'queued';
  if (value === 'running' || value === 'waiting') return 'running';
  if (value === 'idle' || value === 'blocked') return 'blocked';
  if (value === 'failed' || value === 'interrupted') return 'failed';
  if (value === 'completed') return 'failed';
  throw Object.assign(new Error('Codex collaboration returned an unsupported Agent status.'), { code: 'CODEX_COLLABORATION_STATUS_INVALID' });
};

const assertObject = (value, code, message) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error(message), { code });
  return value;
};

const exactKeys = (value, required, code, message) => {
  assertObject(value, code, message);
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw Object.assign(new Error(message), { code });
  return value;
};

const nonEmpty = (value, code, message) => {
  if (typeof value !== 'string' || !value.length) throw Object.assign(new Error(message), { code });
  return value;
};

const snapshotTasks = result => {
  exactKeys(result, ['agents'], 'CODEX_COLLABORATION_SNAPSHOT_INVALID', 'Codex collaboration list_agents result has an invalid envelope.');
  if (!Array.isArray(result.agents)) throw Object.assign(new Error('Codex collaboration list_agents result must contain an Agent list.'), { code: 'CODEX_COLLABORATION_SNAPSHOT_INVALID' });
  return result.agents.map(agent => exactKeys(agent, ['agent_name', 'agent_status'], 'CODEX_COLLABORATION_AGENT_INVALID', 'Codex collaboration Agent observation has unexpected fields.'));
};

const taskFromSnapshot = (result, agentId) => {
  const matches = snapshotTasks(result).filter(agent => agent.agent_name === agentId);
  if (matches.length !== 1) throw Object.assign(new Error(`Codex collaboration task is not uniquely observable: ${agentId}`), { code: matches.length ? 'CODEX_COLLABORATION_AGENT_AMBIGUOUS' : 'CODEX_COLLABORATION_AGENT_NOT_FOUND' });
  return { task: matches[0], status: normalizedStatus(matches[0].agent_status) };
};

const taskForEffect = (tasks, effect) => {
  const returnedTaskName = typeof effect.nativeResult?.task_name === 'string' ? effect.nativeResult.task_name : null;
  const identities = new Set([effect.canonicalAgentName, effect.nativeTaskName, returnedTaskName, effect.taskName].filter(Boolean));
  const matches = tasks.filter(task => identities.has(task.agent_name) || task.agent_name.endsWith(`/${effect.taskName}`));
  if (matches.length > 1) throw Object.assign(new Error(`Codex collaboration task is ambiguous for Host Effect: ${effect.effectId}`), { code: 'CODEX_COLLABORATION_AGENT_AMBIGUOUS' });
  return matches[0] ?? null;
};

const spawnReceiptDigest = receipt => {
  const copy = structuredClone(receipt);
  delete copy.receiptDigest;
  return digestJson(copy);
};

const assertSpawnReceipt = (receipt, expected) => {
  exactKeys(receipt, ['protocolVersion', 'kind', 'provider', 'adapterVersion', 'contract', 'sessionId', 'effectId', 'requestId', 'requestDigest', 'nativeTaskName', 'requestedTaskName', 'agentId', 'projectId', 'runId', 'dispatchId', 'packetDigest', 'promptDigest', 'visibility', 'createdAt', 'receiptDigest'], 'CODEX_COLLABORATION_SPAWN_RECEIPT_INVALID', 'Codex collaboration spawn Receipt is invalid.');
  if (receipt.protocolVersion !== '1.0' || receipt.kind !== 'codex-collaboration-spawn-receipt' || receipt.provider !== 'codex-host' || receipt.adapterVersion !== '1.3.0') throw Object.assign(new Error('Codex collaboration spawn Receipt identity is invalid.'), { code: 'CODEX_COLLABORATION_SPAWN_RECEIPT_INVALID' });
  if (digestJson(receipt.contract) !== digestJson(CODEX_COLLABORATION_NATIVE_CONTRACT)) throw Object.assign(new Error('Codex collaboration spawn Receipt contract is invalid.'), { code: 'CODEX_COLLABORATION_SPAWN_RECEIPT_CONTRACT_MISMATCH' });
  if (receipt.receiptDigest !== spawnReceiptDigest(receipt)) throw Object.assign(new Error('Codex collaboration spawn Receipt digest is invalid.'), { code: 'CODEX_COLLABORATION_SPAWN_RECEIPT_DIGEST_MISMATCH' });
  for (const key of ['agentId', 'dispatchId', 'packetDigest', 'promptDigest']) if (receipt[key] !== expected[key]) throw Object.assign(new Error(`Codex collaboration spawn Receipt ${key} does not match the active Dispatch.`), { code: 'CODEX_COLLABORATION_SPAWN_RECEIPT_BINDING_MISMATCH' });
  if (receipt.visibility?.mode !== 'user-visible' || receipt.visibility.surface !== expected.surface || receipt.visibility.inspectRef !== expected.inspectRef || receipt.agentId !== receipt.visibility.inspectRef) throw Object.assign(new Error('Codex collaboration spawn Receipt visibility is invalid.'), { code: 'CODEX_COLLABORATION_SPAWN_RECEIPT_VISIBILITY_MISMATCH' });
  return receipt;
};

const hostFailureResult = ({ agentId, status, summary, failureClass, code }) => ({
  status,
  summary,
  checkpoints: [{ id: 'codex-collaboration-terminal-status', status, summary, evidence: [`codex-collaboration:${agentId}:${code}`] }],
  made: [],
  notMade: [],
  changedFiles: [],
  observations: [],
  findings: [],
  followUpFeatures: [],
  failureClass,
  blocker: { kind: failureClass, summary, resumeWhen: null, code },
});

const parseTerminalResult = (task, agentId) => {
  if (completedStatus(task.agent_status)) {
    try { return JSON.parse(task.agent_status.completed); }
    catch (error) { throw Object.assign(new Error('Codex collaboration Agent final output must be one strict JSON object with no prose or Markdown.', { cause: error }), { code: 'CODEX_COLLABORATION_RESULT_JSON_INVALID' }); }
  }
  if (failedStatus(task.agent_status)) {
    return hostFailureResult({ agentId, status: 'failed', summary: task.agent_status.failed || `Codex collaboration Agent failed: ${agentId}`, failureClass: 'runtime-provider', code: 'CODEX_COLLABORATION_AGENT_FAILED' });
  }
  if (task.agent_status === 'interrupted') {
    return hostFailureResult({ agentId, status: 'failed', summary: `Codex collaboration Agent was interrupted: ${agentId}`, failureClass: 'runtime-interrupted', code: 'CODEX_COLLABORATION_AGENT_INTERRUPTED' });
  }
  if (task.agent_status === 'failed') {
    return hostFailureResult({ agentId, status: 'failed', summary: `Codex collaboration Agent failed without a provider message: ${agentId}`, failureClass: 'runtime-provider', code: 'CODEX_COLLABORATION_AGENT_FAILED' });
  }
  if (task.agent_status === 'idle' || task.agent_status === 'blocked') {
    return hostFailureResult({ agentId, status: 'blocked', summary: `Codex collaboration Agent is ${task.agent_status}: ${agentId}`, failureClass: 'runtime-blocked', code: 'CODEX_COLLABORATION_AGENT_BLOCKED' });
  }
  if (task.agent_status === 'completed') {
    return hostFailureResult({ agentId, status: 'failed', summary: `Codex collaboration Agent completed without a structured result: ${agentId}`, failureClass: 'runtime-contract', code: 'CODEX_COLLABORATION_RESULT_UNAVAILABLE' });
  }
  throw Object.assign(new Error(`Codex collaboration task has no terminal result: ${agentId}`), { code: 'CODEX_COLLABORATION_RESULT_UNAVAILABLE' });
};

export const createCodexCollaborationHostAdapter = ({ exchange, controlRoot, dataRoot, sessionId = `codex_collaboration_${randomUUID()}`, now = () => new Date().toISOString(), waitTimeoutMs = 60000 } = {}) => {
  if (typeof exchange !== 'function') throw Object.assign(new Error('Codex collaboration Host Adapter requires a trusted host exchange.'), { code: 'CODEX_COLLABORATION_EXCHANGE_REQUIRED' });
  nonEmpty(controlRoot, 'CODEX_COLLABORATION_CONTROL_ROOT_REQUIRED', 'Codex collaboration Host Adapter requires the Control Root.');
  nonEmpty(dataRoot, 'CODEX_COLLABORATION_DATA_ROOT_REQUIRED', 'Codex collaboration Host Adapter requires the data root.');
  if (!Number.isInteger(waitTimeoutMs) || waitTimeoutMs < 1000 || waitTimeoutMs > 60000) throw Object.assign(new Error('Codex collaboration wait timeout must be between 1 and 60 seconds.'), { code: 'CODEX_COLLABORATION_WAIT_TIMEOUT_INVALID' });
  const journal = new CodexHostEffectJournal({ controlRoot, dataRoot, contract: CODEX_COLLABORATION_NATIVE_CONTRACT, now });
  const receipts = new Map();

  const createRequest = ({ operation, tool, arguments: args, binding = null }) => {
    const requestId = `host_request_${randomUUID()}`;
    // Put the native tool and arguments first in the emitted JSON. The current
    // long-lived Windows host channel uses a PTY, so this keeps the exact call payload
    // ahead of the large prompt and away from accidental terminal-wrap transcription.
    const body = { protocolVersion: '1.0', kind: 'codex-visible-host-request', tool, arguments: structuredClone(args), sessionId, requestId, operation, binding: binding ? structuredClone(binding) : null, createdAt: now() };
    return Object.freeze({ ...body, requestDigest: digestJson(body) });
  };

  const executeRequest = async request => ({ request, result: await exchange(request) });
  const hostRequest = async input => executeRequest(createRequest(input));
  const listAll = async binding => {
    const listed = await hostRequest({ operation: 'inspect', tool: 'collaboration.list_agents', arguments: {}, binding });
    return { ...listed, tasks: snapshotTasks(listed.result) };
  };

  const inspect = async ({ agentId, expected = null }) => {
    const listed = await listAll(expected);
    return { ...taskFromSnapshot(listed.result, agentId), request: listed.request };
  };

  const transition = async (effect, state, patch, suffix) => (await journal.transition(effect.effectId, {
    expectedRevision: effect.revision,
    commandId: `${effect.requestId}.${suffix}`,
    state,
    patch,
  })).effect;

  const containEffect = async (effect, { reason = 'reconcile', snapshot = null } = {}) => {
    if (effect.state === 'settled' || effect.state === 'contained') return effect;
    const listed = snapshot ?? await listAll({ effectId: effect.effectId, reason });
    const task = taskForEffect(listed.tasks, effect);
    if (!task || terminalNativeStatus(task.agent_status)) {
      return transition(effect, 'contained', { outcome: { reason, disposition: task ? 'already-terminal' : 'not-observed', observedAgentName: task?.agent_name ?? null, observationRequestDigest: listed.request.requestDigest } }, `contain.${effect.revision}`);
    }
    const target = task.agent_name;
    const interrupted = await hostRequest({ operation: 'interrupt', tool: 'collaboration.interrupt_agent', arguments: { target }, binding: { effectId: effect.effectId, reason } });
    const verified = await listAll({ effectId: effect.effectId, reason: 'verify-containment' });
    const after = taskForEffect(verified.tasks, effect);
    if (after && !terminalNativeStatus(after.agent_status)) {
      throw Object.assign(new Error(`Codex collaboration could not verify containment of ${target}.`), { code: 'CODEX_COLLABORATION_CONTAINMENT_UNVERIFIED', details: { effectId: effect.effectId, target } });
    }
    return transition(effect, 'contained', { canonicalAgentName: target, outcome: { reason, disposition: 'interrupted', target, interruptRequestDigest: interrupted.request.requestDigest, interruptResultDigest: digestJson(interrupted.result), verificationRequestDigest: verified.request.requestDigest } }, `contain.${effect.revision}`);
  };

  const reconcile = async ({ activeEffectIds = [] } = {}) => {
    const active = new Set(activeEffectIds.filter(value => typeof value === 'string' && value.length));
    const listed = await listAll({ contract: CODEX_COLLABORATION_NATIVE_CONTRACT });
    const reconciled = [];
    const issues = [];
    for (let effect of await journal.unresolved()) {
      try {
        if (active.has(effect.effectId)) {
          if (effect.state === 'agent-observed') effect = await transition(effect, 'lease-bound', {}, `reconcile-bind.${effect.revision}`);
          if (effect.state !== 'lease-bound') throw Object.assign(new Error(`Active Lease refers to an incompatible Host Effect state: ${effect.state}`), { code: 'CODEX_HOST_EFFECT_ACTIVE_STATE_INVALID' });
          reconciled.push({ effectId: effect.effectId, disposition: 'active-lease-preserved' });
        } else {
          const contained = await containEffect(effect, { reason: 'preflight-reconciliation', snapshot: listed });
          reconciled.push({ effectId: contained.effectId, disposition: contained.outcome?.disposition ?? 'contained' });
        }
      } catch (error) {
        issues.push({ effectId: effect.effectId, code: error.code ?? 'CODEX_HOST_EFFECT_RECONCILIATION_FAILED', message: error.message });
      }
    }
    return {
      ready: issues.length === 0,
      provider: 'codex-host',
      adapterVersion: '1.3.0',
      contract: structuredClone(CODEX_COLLABORATION_NATIVE_CONTRACT),
      assertionId: listed.request.requestDigest,
      observedAt: now(),
      reconciled,
      issues,
    };
  };

  const adapter = createCodexVisibleHostAdapter({
    adapterVersion: '1.3.0',
    reconcileVisibleHostEffects: reconcile,
    spawnVisibleAgent: async input => {
      const binding = {
        projectId: nonEmpty(input?.projectId, 'CODEX_COLLABORATION_PROJECT_REQUIRED', 'Visible spawn requires a Project ID.'),
        runId: nonEmpty(input?.runId, 'CODEX_COLLABORATION_RUN_REQUIRED', 'Visible spawn requires a Run ID.'),
        dispatchId: nonEmpty(input?.dispatchId, 'CODEX_COLLABORATION_DISPATCH_REQUIRED', 'Visible spawn requires a Dispatch ID.'),
        packetDigest: nonEmpty(input?.packetDigest, 'CODEX_COLLABORATION_PACKET_REQUIRED', 'Visible spawn requires a packet digest.'),
        promptDigest: nonEmpty(input?.promptDigest, 'CODEX_COLLABORATION_PROMPT_REQUIRED', 'Visible spawn requires a Prompt digest.'),
      };
      const prompt = nonEmpty(input?.prompt, 'CODEX_COLLABORATION_PROMPT_REQUIRED', 'Visible spawn requires the generated Prompt text.');
      const unresolved = await journal.unresolved();
      if (unresolved.length) throw Object.assign(new Error('Codex collaboration has unresolved Host Effects; reconciliation is required before another spawn.'), { code: 'CODEX_HOST_EFFECT_RECONCILIATION_REQUIRED', details: { effectIds: unresolved.map(effect => effect.effectId) } });
      const taskName = `ah_${digestJson({ sessionId, ...binding }).slice(0, 20)}`;
      const request = createRequest({ operation: 'spawn', tool: 'collaboration.spawn_agent', arguments: { task_name: taskName, fork_turns: 'none', message: prompt }, binding });
      let effect = (await journal.prepare({ request, taskName, binding })).effect;
      try {
        const result = await exchange(request);
        effect = await transition(effect, 'spawn-responded', { nativeResult: structuredClone(result) }, 'spawn-responded');
        exactKeys(result, ['task_name'], 'CODEX_COLLABORATION_SPAWN_RESULT_INVALID', 'Codex collaboration spawn_agent result has an invalid envelope.');
        const nativeTaskName = nonEmpty(result.task_name, 'CODEX_COLLABORATION_TASK_NAME_REQUIRED', 'Codex collaboration spawn_agent did not return a canonical task name.');
        if (nativeTaskName !== taskName && !nativeTaskName.endsWith(`/${taskName}`)) throw Object.assign(new Error('Codex collaboration spawn_agent returned a task name that does not match the requested task.'), { code: 'CODEX_COLLABORATION_TASK_NAME_MISMATCH', details: { requestedTaskName: taskName, nativeTaskName } });
        const listed = await listAll({ effectId: effect.effectId, ...binding });
        const matches = listed.tasks.filter(task => task.agent_name === nativeTaskName);
        if (matches.length !== 1) throw Object.assign(new Error(`Codex collaboration did not expose the returned canonical task ${nativeTaskName}.`), { code: matches.length ? 'CODEX_COLLABORATION_AGENT_AMBIGUOUS' : 'CODEX_COLLABORATION_AGENT_NOT_FOUND' });
        const agentId = matches[0].agent_name;
        effect = await transition(effect, 'agent-observed', { nativeTaskName, canonicalAgentName: agentId }, 'agent-observed');
        const visibility = { mode: 'user-visible', surface: 'codex-collaboration-tree', inspectRef: agentId };
        const receiptBody = { protocolVersion: '1.0', kind: 'codex-collaboration-spawn-receipt', provider: 'codex-host', adapterVersion: '1.3.0', contract: structuredClone(CODEX_COLLABORATION_NATIVE_CONTRACT), sessionId, effectId: effect.effectId, requestId: request.requestId, requestDigest: request.requestDigest, nativeTaskName, requestedTaskName: taskName, agentId, ...binding, visibility, createdAt: now() };
        const receipt = { ...receiptBody, receiptDigest: spawnReceiptDigest(receiptBody) };
        receipts.set(effect.effectId, receipt);
        return { agentId, visibility, receipt };
      } catch (error) {
        try {
          effect = await journal.read(effect.effectId, { required: true });
          const contained = await containEffect(effect, { reason: error.code ?? 'spawn-failed' });
          error.details = { ...(error.details ?? {}), effectId: effect.effectId, containment: contained.outcome };
        } catch (containmentError) {
          error.details = { ...(error.details ?? {}), effectId: effect.effectId, containmentError: { code: containmentError.code ?? 'CODEX_COLLABORATION_CONTAINMENT_FAILED', message: containmentError.message } };
        }
        throw error;
      }
    },
    inspectVisibleAgent: async expected => {
      const receipt = assertSpawnReceipt(expected.hostSpawnReceipt, { ...expected, agentId: expected.agentId, surface: expected.surface, inspectRef: expected.inspectRef });
      const effect = await journal.read(receipt.effectId, { required: true });
      if (!['agent-observed', 'lease-bound', 'settled'].includes(effect.state)) throw Object.assign(new Error('Codex collaboration Host Effect is not observable.'), { code: 'CODEX_HOST_EFFECT_NOT_OBSERVABLE' });
      const observed = await inspect({ agentId: expected.agentId, expected: { effectId: receipt.effectId, dispatchId: expected.dispatchId, packetDigest: expected.packetDigest, promptDigest: expected.promptDigest } });
      return { verified: true, status: observed.status, assertionId: observed.request.requestDigest, observedAt: now(), agentId: expected.agentId, dispatchId: expected.dispatchId, packetDigest: expected.packetDigest, promptDigest: expected.promptDigest, visibility: { mode: 'user-visible', surface: expected.surface, inspectRef: expected.inspectRef } };
    },
    confirmVisibleLease: async input => {
      const receipt = assertSpawnReceipt(input?.runtimeReceipt?.hostSpawnReceipt, { ...input, agentId: input.agentId, surface: input.runtimeReceipt?.visibility?.surface, inspectRef: input.runtimeReceipt?.visibility?.inspectRef });
      let effect = await journal.read(receipt.effectId, { required: true });
      if (effect.state === 'lease-bound') return { confirmed: true, effectId: effect.effectId, reused: true };
      effect = await transition(effect, 'lease-bound', {}, 'lease-bound');
      return { confirmed: true, effectId: effect.effectId, revision: effect.revision };
    },
    containVisibleAgent: async input => {
      const receipt = input?.runtimeReceipt?.hostSpawnReceipt ?? input?.hostSpawnReceipt ?? receipts.get(input?.effectId);
      const effectId = receipt?.effectId ?? input?.effectId;
      const effect = await journal.read(nonEmpty(effectId, 'CODEX_HOST_EFFECT_ID_REQUIRED', 'Visible Agent containment requires a Host Effect ID.'), { required: true });
      const contained = await containEffect(effect, { reason: input?.reason ?? 'lifecycle-failed' });
      return { contained: true, effectId: contained.effectId, outcome: contained.outcome };
    },
    waitVisibleAgent: async input => {
      const waited = await hostRequest({ operation: 'wait', tool: 'collaboration.wait_agent', arguments: { timeout_ms: waitTimeoutMs }, binding: { agentId: input.agentId, dispatchId: input.dispatchId } });
      exactKeys(waited.result, ['message', 'timed_out'], 'CODEX_COLLABORATION_WAIT_RESULT_INVALID', 'Codex collaboration wait_agent result has an invalid envelope.');
      if (typeof waited.result.message !== 'string' || typeof waited.result.timed_out !== 'boolean') throw Object.assign(new Error('Codex collaboration wait_agent result is invalid.'), { code: 'CODEX_COLLABORATION_WAIT_RESULT_INVALID' });
      const observed = await inspect({ agentId: input.agentId, expected: { dispatchId: input.dispatchId } });
      return { status: observed.status, progress: observed.status, receipt: { provider: 'codex-host', operation: 'wait', waitRequestDigest: waited.request.requestDigest, inspectRequestDigest: observed.request.requestDigest, timedOut: waited.result.timed_out } };
    },
    readVisibleResult: async input => {
      const receipt = assertSpawnReceipt(input?.runtimeReceipt?.hostSpawnReceipt, { agentId: input.agentId, dispatchId: input.dispatchId, packetDigest: input.runtimeReceipt?.hostSpawnReceipt?.packetDigest, promptDigest: input.runtimeReceipt?.hostSpawnReceipt?.promptDigest, surface: input.runtimeReceipt?.visibility?.surface, inspectRef: input.runtimeReceipt?.visibility?.inspectRef });
      const observed = await inspect({ agentId: input.agentId, expected: { effectId: receipt.effectId, dispatchId: input.dispatchId } });
      let result;
      let resultRejection = null;
      try {
        result = parseTerminalResult(observed.task, input.agentId);
        assertJsonSchema(result, visibleResultSchema, { code: 'CODEX_COLLABORATION_RESULT_SCHEMA_INVALID', label: 'Codex collaboration result' });
      } catch (error) {
        if (!completedStatus(observed.task.agent_status) || !['CODEX_COLLABORATION_RESULT_JSON_INVALID', 'CODEX_COLLABORATION_RESULT_SCHEMA_INVALID'].includes(error.code)) throw error;
        const rejectionBody = {
          kind: 'result-rejected-receipt', version: '1.0',
          agentId: input.agentId, dispatchId: input.dispatchId,
          packetDigest: receipt.packetDigest, promptDigest: receipt.promptDigest,
          resultContractDigest: input.runtimeReceipt?.resultContractDigest ?? null,
          code: error.code,
          nativeOutputDigest: sha256(observed.task.agent_status.completed),
          errors: structuredClone(error.details?.errors ?? []),
          observationRequestDigest: observed.request.requestDigest,
        };
        resultRejection = { ...rejectionBody, receiptDigest: digestJson(rejectionBody) };
        result = hostFailureResult({
          agentId: input.agentId,
          status: 'failed',
          summary: `Codex collaboration Agent returned an invalid structured result: ${error.code}`,
          failureClass: 'runtime-contract',
          code: error.code,
        });
      }
      const resultDigest = digestJson(result);
      let effect = await journal.read(receipt.effectId, { required: true });
      if (effect.state === 'lease-bound') effect = await transition(effect, 'settled', { outcome: { disposition: resultRejection ? 'result-rejected' : 'result-observed', resultDigest, observationRequestDigest: observed.request.requestDigest, ...(resultRejection ? { rejectionDigest: resultRejection.receiptDigest } : {}) } }, 'settled');
      const verificationReceipts = Array.isArray(result?.checkpoints) ? result.checkpoints.map(checkpoint => ({ provider: 'codex-host', agentId: input.agentId, dispatchId: input.dispatchId, checkpointId: checkpoint?.id ?? null, status: checkpoint?.status ?? null, evidence: structuredClone(checkpoint?.evidence ?? []), resultDigest, observationRequestDigest: observed.request.requestDigest })) : [];
      return { result, runtimeEvidence: { verificationReceipts, ...(resultRejection ? { resultRejection } : {}) }, receipt: { provider: 'codex-host', operation: 'result', agentId: input.agentId, dispatchId: input.dispatchId, effectId: effect.effectId, resultDigest, observationRequestDigest: observed.request.requestDigest, ...(resultRejection ? { rejectionDigest: resultRejection.receiptDigest } : {}) } };
    },
    interruptVisibleAgent: async input => {
      const receipt = input?.runtimeReceipt?.hostSpawnReceipt ?? input?.hostSpawnReceipt;
      const effect = await journal.read(nonEmpty(receipt?.effectId, 'CODEX_HOST_EFFECT_ID_REQUIRED', 'Visible Agent interruption requires a Host Effect ID.'), { required: true });
      const contained = await containEffect(effect, { reason: input?.reason ?? 'interrupt-requested' });
      return { contained: true, effectId: contained.effectId, outcome: contained.outcome };
    },
  });

  return Object.freeze({ adapter, sessionId, journal, contract: CODEX_COLLABORATION_NATIVE_CONTRACT });
};
