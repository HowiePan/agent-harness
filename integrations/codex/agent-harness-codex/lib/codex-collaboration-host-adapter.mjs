import { randomUUID } from 'node:crypto';
import { createCodexVisibleHostAdapter } from '../../../../src/plugins/runtime/codex-runtime.mjs';
import { digestJson } from '../../../../src/canonical.mjs';

const completedStatus = value => value && typeof value === 'object' && !Array.isArray(value) && typeof value.completed === 'string';
const failedStatus = value => value && typeof value === 'object' && !Array.isArray(value) && typeof value.failed === 'string';
const normalizedStatus = value => {
  if (completedStatus(value)) return 'completed';
  if (failedStatus(value)) return 'failed';
  if (value === 'running' || value === 'pending' || value === 'waiting' || value === 'idle') return 'running';
  if (value === 'blocked') return 'blocked';
  if (value === 'failed') return 'failed';
  if (value === 'completed') return 'completed';
  throw Object.assign(new Error('Codex collaboration returned an unsupported Agent status.'), { code: 'CODEX_COLLABORATION_STATUS_INVALID' });
};

const assertObject = (value, code, message) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error(message), { code });
  return value;
};

const exactKeys = (value, allowed, code, message) => {
  assertObject(value, code, message);
  if (Object.keys(value).some(key => !allowed.includes(key))) throw Object.assign(new Error(message), { code });
  return value;
};

const nonEmpty = (value, code, message) => {
  if (typeof value !== 'string' || !value.length) throw Object.assign(new Error(message), { code });
  return value;
};

const taskFromSnapshot = (result, agentId) => {
  exactKeys(result, ['agents'], 'CODEX_COLLABORATION_SNAPSHOT_INVALID', 'Codex collaboration list_agents result has an invalid envelope.');
  if (!Array.isArray(result.agents)) throw Object.assign(new Error('Codex collaboration list_agents result must contain an Agent list.'), { code: 'CODEX_COLLABORATION_SNAPSHOT_INVALID' });
  const matches = result.agents.filter(agent => agent?.agent_name === agentId);
  if (matches.length !== 1) throw Object.assign(new Error(`Codex collaboration task is not uniquely observable: ${agentId}`), { code: matches.length ? 'CODEX_COLLABORATION_AGENT_AMBIGUOUS' : 'CODEX_COLLABORATION_AGENT_NOT_FOUND' });
  const task = matches[0];
  exactKeys(task, ['agent_name', 'agent_status'], 'CODEX_COLLABORATION_AGENT_INVALID', 'Codex collaboration Agent observation has unexpected fields.');
  return { task, status: normalizedStatus(task.agent_status) };
};

const spawnReceiptDigest = receipt => {
  const copy = structuredClone(receipt);
  delete copy.receiptDigest;
  return digestJson(copy);
};

const assertSpawnReceipt = (receipt, expected) => {
  exactKeys(receipt, ['protocolVersion', 'kind', 'provider', 'adapterVersion', 'sessionId', 'requestId', 'requestDigest', 'agentId', 'dispatchId', 'packetDigest', 'promptDigest', 'visibility', 'createdAt', 'receiptDigest'], 'CODEX_COLLABORATION_SPAWN_RECEIPT_INVALID', 'Codex collaboration spawn Receipt is invalid.');
  if (receipt.protocolVersion !== '1.0' || receipt.kind !== 'codex-collaboration-spawn-receipt' || receipt.provider !== 'codex-host' || receipt.adapterVersion !== '1.0.0') throw Object.assign(new Error('Codex collaboration spawn Receipt identity is invalid.'), { code: 'CODEX_COLLABORATION_SPAWN_RECEIPT_INVALID' });
  if (receipt.receiptDigest !== spawnReceiptDigest(receipt)) throw Object.assign(new Error('Codex collaboration spawn Receipt digest is invalid.'), { code: 'CODEX_COLLABORATION_SPAWN_RECEIPT_DIGEST_MISMATCH' });
  for (const key of ['agentId', 'dispatchId', 'packetDigest', 'promptDigest']) if (receipt[key] !== expected[key]) throw Object.assign(new Error(`Codex collaboration spawn Receipt ${key} does not match the active Dispatch.`), { code: 'CODEX_COLLABORATION_SPAWN_RECEIPT_BINDING_MISMATCH' });
  if (receipt.visibility?.mode !== 'user-visible' || receipt.visibility.surface !== expected.surface || receipt.visibility.inspectRef !== expected.inspectRef || receipt.agentId !== receipt.visibility.inspectRef) throw Object.assign(new Error('Codex collaboration spawn Receipt visibility is invalid.'), { code: 'CODEX_COLLABORATION_SPAWN_RECEIPT_VISIBILITY_MISMATCH' });
  return receipt;
};

const parseCompletedResult = (task, agentId) => {
  if (!completedStatus(task.agent_status)) throw Object.assign(new Error(`Codex collaboration task has no completed structured result: ${agentId}`), { code: 'CODEX_COLLABORATION_RESULT_UNAVAILABLE' });
  try { return JSON.parse(task.agent_status.completed); }
  catch (error) { throw Object.assign(new Error('Codex collaboration Agent final output must be one strict JSON object with no prose or Markdown.', { cause: error }), { code: 'CODEX_COLLABORATION_RESULT_JSON_INVALID' }); }
};

export const createCodexCollaborationHostAdapter = ({ exchange, sessionId = `codex_collaboration_${randomUUID()}`, now = () => new Date().toISOString(), waitTimeoutMs = 60000 } = {}) => {
  if (typeof exchange !== 'function') throw Object.assign(new Error('Codex collaboration Host Adapter requires a trusted host exchange.'), { code: 'CODEX_COLLABORATION_EXCHANGE_REQUIRED' });
  if (!Number.isInteger(waitTimeoutMs) || waitTimeoutMs < 1000 || waitTimeoutMs > 60000) throw Object.assign(new Error('Codex collaboration wait timeout must be between 1 and 60 seconds.'), { code: 'CODEX_COLLABORATION_WAIT_TIMEOUT_INVALID' });
  const spawned = new Map();

  const hostRequest = async ({ operation, tool, arguments: args, binding = null }) => {
    const requestId = `host_request_${randomUUID()}`;
    const body = { protocolVersion: '1.0', kind: 'codex-visible-host-request', sessionId, requestId, operation, tool, arguments: structuredClone(args), binding: binding ? structuredClone(binding) : null, createdAt: now() };
    const request = Object.freeze({ ...body, requestDigest: digestJson(body) });
    const result = await exchange(request);
    return { request, result };
  };

  const inspect = async ({ agentId, expected = null }) => {
    const { request, result } = await hostRequest({ operation: 'inspect', tool: 'collaboration.list_agents', arguments: { path_prefix: agentId }, binding: expected });
    const observed = taskFromSnapshot(result, agentId);
    return { ...observed, request };
  };

  const adapter = createCodexVisibleHostAdapter({
    adapterVersion: '1.0.0',
    spawnVisibleAgent: async input => {
      const binding = {
        dispatchId: nonEmpty(input?.dispatchId, 'CODEX_COLLABORATION_DISPATCH_REQUIRED', 'Visible spawn requires a Dispatch ID.'),
        packetDigest: nonEmpty(input?.packetDigest, 'CODEX_COLLABORATION_PACKET_REQUIRED', 'Visible spawn requires a packet digest.'),
        promptDigest: nonEmpty(input?.promptDigest, 'CODEX_COLLABORATION_PROMPT_REQUIRED', 'Visible spawn requires a Prompt digest.'),
      };
      const prompt = nonEmpty(input?.prompt, 'CODEX_COLLABORATION_PROMPT_REQUIRED', 'Visible spawn requires the generated Prompt text.');
      const taskName = `ah_${digestJson({ sessionId, ...binding }).slice(0, 20)}`;
      if (spawned.has(taskName)) throw Object.assign(new Error(`Codex collaboration task name was reused: ${taskName}`), { code: 'CODEX_COLLABORATION_TASK_REUSED' });
      const { request, result } = await hostRequest({ operation: 'spawn', tool: 'collaboration.spawn_agent', arguments: { task_name: taskName, fork_turns: 'none', message: prompt }, binding });
      exactKeys(result, ['task_name'], 'CODEX_COLLABORATION_SPAWN_RESULT_INVALID', 'Codex collaboration spawn_agent result has an invalid envelope.');
      const agentId = nonEmpty(result.task_name, 'CODEX_COLLABORATION_AGENT_ID_REQUIRED', 'Codex collaboration spawn_agent did not return a canonical task name.');
      if (!(agentId === taskName || agentId.endsWith(`/${taskName}`))) throw Object.assign(new Error('Codex collaboration spawn_agent returned a task identity different from the requested task.'), { code: 'CODEX_COLLABORATION_AGENT_ID_MISMATCH' });
      const visibility = { mode: 'user-visible', surface: 'codex-collaboration-tree', inspectRef: agentId };
      const receiptBody = { protocolVersion: '1.0', kind: 'codex-collaboration-spawn-receipt', provider: 'codex-host', adapterVersion: '1.0.0', sessionId, requestId: request.requestId, requestDigest: request.requestDigest, agentId, ...binding, visibility, createdAt: now() };
      const receipt = { ...receiptBody, receiptDigest: spawnReceiptDigest(receiptBody) };
      spawned.set(taskName, receipt);
      return { agentId, visibility, receipt };
    },
    inspectVisibleAgent: async expected => {
      assertSpawnReceipt(expected.hostSpawnReceipt, { ...expected, agentId: expected.agentId, surface: expected.surface, inspectRef: expected.inspectRef });
      const observed = await inspect({ agentId: expected.agentId, expected: { dispatchId: expected.dispatchId, packetDigest: expected.packetDigest, promptDigest: expected.promptDigest } });
      return {
        verified: true,
        status: observed.status,
        assertionId: observed.request.requestDigest,
        observedAt: now(),
        agentId: expected.agentId,
        dispatchId: expected.dispatchId,
        packetDigest: expected.packetDigest,
        promptDigest: expected.promptDigest,
        visibility: { mode: 'user-visible', surface: expected.surface, inspectRef: expected.inspectRef },
      };
    },
    waitVisibleAgent: async input => {
      const waited = await hostRequest({ operation: 'wait', tool: 'collaboration.wait_agent', arguments: { timeout_ms: waitTimeoutMs }, binding: { agentId: input.agentId, dispatchId: input.dispatchId } });
      exactKeys(waited.result, ['message', 'timed_out'], 'CODEX_COLLABORATION_WAIT_RESULT_INVALID', 'Codex collaboration wait_agent result has an invalid envelope.');
      if (typeof waited.result.message !== 'string' || (waited.result.timed_out !== undefined && typeof waited.result.timed_out !== 'boolean')) throw Object.assign(new Error('Codex collaboration wait_agent result is invalid.'), { code: 'CODEX_COLLABORATION_WAIT_RESULT_INVALID' });
      const observed = await inspect({ agentId: input.agentId, expected: { dispatchId: input.dispatchId } });
      return { status: observed.status, progress: observed.status, receipt: { provider: 'codex-host', operation: 'wait', waitRequestDigest: waited.request.requestDigest, inspectRequestDigest: observed.request.requestDigest, timedOut: waited.result.timed_out === true } };
    },
    readVisibleResult: async input => {
      const observed = await inspect({ agentId: input.agentId, expected: { dispatchId: input.dispatchId } });
      const result = parseCompletedResult(observed.task, input.agentId);
      const resultDigest = digestJson(result);
      const verificationReceipts = Array.isArray(result?.checkpoints) ? result.checkpoints.map(checkpoint => ({
        provider: 'codex-host',
        agentId: input.agentId,
        dispatchId: input.dispatchId,
        checkpointId: checkpoint?.id ?? null,
        status: checkpoint?.status ?? null,
        evidence: structuredClone(checkpoint?.evidence ?? []),
        resultDigest,
        observationRequestDigest: observed.request.requestDigest,
      })) : [];
      return {
        result,
        runtimeEvidence: { verificationReceipts },
        receipt: { provider: 'codex-host', operation: 'result', agentId: input.agentId, dispatchId: input.dispatchId, resultDigest, observationRequestDigest: observed.request.requestDigest },
      };
    },
  });

  return Object.freeze({ adapter, sessionId });
};
