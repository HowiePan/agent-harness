import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { StringDecoder } from 'node:string_decoder';
import { createInterface } from 'node:readline';
import { digestJson, sha256 } from '../../../../src/common/canonical.mjs';
import { assertHarnessWritePath } from '../../../../src/common/write-boundary.mjs';
import { atomicWriteJson } from '../../../../src/kernel/atomic-io.mjs';
import { createHostResponseEnvelope } from './stdio-host-exchange.mjs';
import { resolveCodexThreadWithMetadata } from './codex-rollout-locator.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const delay = ms => new Promise(done => setTimeout(done, ms));
const allowedTools = new Set(['collaboration.spawn_agent', 'collaboration.list_agents', 'collaboration.wait_agent', 'collaboration.interrupt_agent']);
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
const normalizeHostPath = path => process.platform === 'win32' && path.startsWith('\\\\?\\') ? path.slice(4) : path;
const samePath = (left, right) => process.platform === 'win32' ? resolve(normalizeHostPath(left)).toLowerCase() === resolve(normalizeHostPath(right)).toLowerCase() : resolve(left) === resolve(right);

export const locateCodexRollout = async ({ codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'), codexSessionId, expectedCwd = process.cwd(), stateDbPath = null } = {}) => {
  if (!safeId(codexSessionId)) fail('CODEX_ROLLOUT_SESSION_INVALID', 'Rollout Host exchange requires the current Codex session ID.');
  const home = await realpath(resolve(codexHome));
  const databasePath = await realpath(resolve(stateDbPath ?? join(home, 'state_5.sqlite')));
  if (!inside(home, databasePath)) fail('CODEX_ROLLOUT_DATABASE_PATH_INVALID', 'Codex state database is outside CODEX_HOME.');
  const located = await resolveCodexThreadWithMetadata({ databasePath, codexSessionId, codexHome: home, expectedCwd, Database: DatabaseSync });
  if (located.host) return located.host;
  const row = located.row;
  if (!row || row.id !== codexSessionId || !samePath(row.cwd, expectedCwd)) fail('CODEX_ROLLOUT_SESSION_NOT_BOUND', 'Codex state database does not bind this session to the current workspace.');
  const path = await realpath(normalizeHostPath(row.rollout_path));
  if (!inside(join(home, 'sessions'), path) || !path.toLowerCase().endsWith('.jsonl') || !path.includes(codexSessionId)) fail('CODEX_ROLLOUT_PATH_INVALID', 'Codex rollout path is not bound to this session under CODEX_HOME.');
  return { path, cliVersion: row.cli_version, codexHome: home };
};

/** Read an already attested native observation from its original rollout. No new Host call is implied. */
export const readCodexRolloutObservation = async ({ controlRoot, dataRoot, sessionId, expectedCwd,
  observationRequestDigest, agentId, locate = locateCodexRollout } = {}) => {
  if (!safeId(sessionId) || !safeId(agentId?.split('/').at(-1)) || !/^[a-f0-9]{64}$/.test(observationRequestDigest ?? ''))
    fail('CODEX_ROLLOUT_HISTORICAL_SCOPE_INVALID', 'Historical Host observation requires a bound session, Agent, and request digest.');
  const receiptRoot = assertHarnessWritePath(resolve(dataRoot, 'host-bridge', 'rollout-receipts'), 'Codex rollout Host receipts', controlRoot);
  const receipts = [];
  const names = (await readdir(receiptRoot)).filter(name => /^host_request_[A-Za-z0-9_-]+-[A-Za-z0-9_-]+\.json$/.test(name));
  for (let index = 0; index < names.length; index += 64) {
    const batch = await Promise.all(names.slice(index, index + 64).map(async name => JSON.parse(await readFile(resolve(receiptRoot, name), 'utf8'))));
    receipts.push(...batch.filter(receipt => receipt.sessionId === sessionId && receipt.requestDigest === observationRequestDigest));
    if (receipts.length > 1) break;
  }
  if (receipts.length !== 1) fail('CODEX_ROLLOUT_HISTORICAL_RECEIPT_REQUIRED', 'Exactly one original Host receipt must bind the terminal observation.');
  const receipt = receipts[0];
  const { receiptDigest, ...body } = receipt;
  if (receipt.protocolVersion !== '1.0' || receipt.kind !== 'codex-rollout-host-receipt' || receipt.tool !== 'collaboration.list_agents'
    || receiptDigest !== digestJson(body) || !safeId(receipt.callId) || !safeId(receipt.outputId)
    || receipt.argumentsDigest !== digestJson({}))
    fail('CODEX_ROLLOUT_HISTORICAL_RECEIPT_INVALID', 'Original Host receipt is invalid or does not bind a native Agent observation.');
  const host = await locate({ codexSessionId: sessionId, expectedCwd });
  if (sha256(host.path) !== receipt.rolloutPathDigest || host.cliVersion !== receipt.codexVersion)
    fail('CODEX_ROLLOUT_HISTORICAL_PATH_MISMATCH', 'Original Host receipt does not bind this Codex rollout.');
  let call = null;
  let output = null;
  const lines = createInterface({ input: createReadStream(host.path, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.includes(receipt.callId) && !line.includes(receipt.outputId)) continue;
      if (Buffer.byteLength(line) > 8 * 1024 * 1024) fail('CODEX_ROLLOUT_HISTORICAL_LINE_INVALID', 'Original Host observation exceeds the native event limit.');
      let record;
      try { record = JSON.parse(line); } catch { fail('CODEX_ROLLOUT_HISTORICAL_LINE_INVALID', 'Original Host observation is not valid JSON.'); }
      if (record?.type !== 'response_item') continue;
      const item = record.payload;
      if (item?.type === 'function_call' && item.call_id === receipt.callId) {
        let argumentsValue;
        try { argumentsValue = JSON.parse(item.arguments); }
        catch { fail('CODEX_ROLLOUT_HISTORICAL_CALL_MISMATCH', 'Original native Agent observation arguments are invalid.'); }
        if (call || item.namespace !== 'collaboration' || item.name !== 'list_agents'
          || item.internal_chat_message_metadata_passthrough?.turn_id !== receipt.turnId
          || digestJson(argumentsValue) !== receipt.argumentsDigest)
          fail('CODEX_ROLLOUT_HISTORICAL_CALL_MISMATCH', 'Original native Agent observation call differs from its receipt.');
        call = item;
      }
      if (item?.type === 'function_call_output' && item.call_id === receipt.callId && item.id === receipt.outputId) {
        if (output || record.ordinal !== receipt.ordinal
          || item.internal_chat_message_metadata_passthrough?.turn_id !== receipt.turnId)
          fail('CODEX_ROLLOUT_HISTORICAL_OUTPUT_MISMATCH', 'Original native Agent observation output differs from its receipt.');
        try { output = JSON.parse(item.output); } catch { fail('CODEX_ROLLOUT_HISTORICAL_OUTPUT_INVALID', 'Original native Agent observation is not valid JSON.'); }
      }
    }
  } finally { lines.close(); }
  if (!call || !output || digestJson(output) !== receipt.resultDigest || !Array.isArray(output.agents))
    fail('CODEX_ROLLOUT_HISTORICAL_OUTPUT_MISMATCH', 'Original native Agent observation cannot be verified against its receipt.');
  const matches = output.agents.filter(item => item?.agent_name === agentId);
  if (matches.length !== 1 || typeof matches[0]?.agent_status?.completed !== 'string')
    fail('CODEX_ROLLOUT_HISTORICAL_TERMINAL_REQUIRED', 'The bound original Agent has no unique completed native result.');
  let result;
  try { result = JSON.parse(matches[0].agent_status.completed); }
  catch { fail('CODEX_ROLLOUT_HISTORICAL_RESULT_INVALID', 'The original completed Agent result is not structured JSON.'); }
  return { receipt, result };
};

const validateRequest = (request, sessionId) => {
  if (!safeId(request?.requestId) || !allowedTools.has(request?.tool) || request.sessionId !== sessionId) fail('CODEX_ROLLOUT_REQUEST_INVALID', 'Rollout Host request has an invalid session, ID, or tool.');
  const { requestDigest, ...body } = request;
  if (requestDigest !== digestJson(body)) fail('CODEX_ROLLOUT_REQUEST_DIGEST_MISMATCH', 'Rollout Host request digest is invalid.');
  if (!request.arguments || typeof request.arguments !== 'object' || Array.isArray(request.arguments)) fail('CODEX_ROLLOUT_ARGUMENTS_INVALID', 'Rollout Host request arguments must be an object.');
};

const matchesNativeArguments = (args, request) => {
  if (request.tool !== 'collaboration.spawn_agent') return digestJson(args) === digestJson(request.arguments) ? 'full' : null;
  const expectedTaskName = `ah_${digestJson({ sessionId: request.sessionId, ...request.binding }).slice(0, 20)}`;
  if (request.arguments.task_name !== expectedTaskName || args?.task_name !== expectedTaskName || args?.fork_turns !== 'none') return null;
  if (args.message === request.arguments.message) return 'full';
  // Codex encrypts long spawn messages in the parent rollout. The task name
  // still binds the Dispatch and Prompt digests, but message bytes are not
  // observable here; preserve that limitation in the Host receipt.
  return typeof args.message === 'string' && /^gAAAA[A-Za-z0-9_-]+={0,2}$/.test(args.message) ? 'host-redacted-message' : null;
};

const parseNativeLine = (line, request, calls) => {
  let record;
  try { record = JSON.parse(line); }
  catch { fail('CODEX_ROLLOUT_LINE_INVALID', 'Codex rollout contains an incomplete or invalid JSON line after the Host request.'); }
  if (record?.type !== 'response_item') return null;
  const item = record.payload;
  const [namespace, name] = request.tool.split('.');
  if (item?.type === 'function_call' && item.namespace === namespace && item.name === name) {
    if (!safeId(item.call_id) || typeof item.arguments !== 'string') fail('CODEX_ROLLOUT_CALL_INVALID', 'Native collaboration call lacks its call ID or argument frame.');
    let args;
    try { args = JSON.parse(item.arguments); }
    catch { fail('CODEX_ROLLOUT_CALL_ARGUMENTS_INVALID', 'Native collaboration call arguments are not JSON.'); }
    const argumentAttestation = matchesNativeArguments(args, request);
    if (!argumentAttestation) return null;
    calls.set(item.call_id, { turnId: item.internal_chat_message_metadata_passthrough?.turn_id ?? null, offset: record.ordinal, tool: request.tool, argumentAttestation });
    if (calls.size > 1) fail('CODEX_ROLLOUT_CALL_AMBIGUOUS', 'More than one native collaboration call matches the pending Host request.');
    return null;
  }
  if (item?.type !== 'function_call_output' || !calls.has(item.call_id)) return null;
  const call = calls.get(item.call_id);
  if (!safeId(item.id) || item.internal_chat_message_metadata_passthrough?.turn_id !== call.turnId || !call.turnId || typeof item.output !== 'string') fail('CODEX_ROLLOUT_OUTPUT_INVALID', 'Native collaboration output lacks a bound call, turn, or output frame.');
  const executed = item.internal_chat_message_metadata_passthrough?.executed_tool_calls;
  if (call.argumentAttestation === 'host-redacted-message') {
    // Some Codex hosts omit executed_tool_calls for an otherwise bound native
    // call. The call/output IDs and turn still prove native execution, while
    // the encrypted message cannot prove the original Prompt bytes.
    if (executed !== undefined) {
      const metadata = executed?.[0]?.arguments?._codex_executed_tool_call_truncated;
      if (!Array.isArray(executed) || executed.length !== 1 || executed[0]?.name !== `${namespace}__${name}` || !Number.isSafeInteger(metadata?.original_bytes) || metadata.original_bytes < Buffer.byteLength(request.arguments.message) || !Number.isSafeInteger(metadata?.max_bytes)) fail('CODEX_ROLLOUT_TOOL_METADATA_MISMATCH', 'Codex redacted spawn metadata conflicts with the native tool execution.');
    }
  } else if (executed && (!Array.isArray(executed) || executed.length !== 1 || executed[0]?.name !== `${namespace}__${name}` || digestJson(executed[0]?.arguments) !== digestJson(request.arguments))) fail('CODEX_ROLLOUT_TOOL_METADATA_MISMATCH', 'Codex executed-tool metadata differs from the pending native call.');
  let result;
  try { result = JSON.parse(item.output); }
  catch { fail('CODEX_ROLLOUT_RESULT_JSON_INVALID', 'Native collaboration output is not a JSON object.'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) fail('CODEX_ROLLOUT_RESULT_INVALID', 'Native collaboration output is not an object.');
  if (call.argumentAttestation === 'host-redacted-message' && (Object.keys(result).length !== 1 || typeof result.task_name !== 'string' || !result.task_name.endsWith(`/${request.arguments.task_name}`))) fail('CODEX_ROLLOUT_SPAWN_RESULT_MISMATCH', 'Redacted native spawn output does not identify the requested task.');
  return { result, callId: item.call_id, outputId: item.id, turnId: call.turnId, ordinal: record.ordinal, argumentAttestation: call.argumentAttestation, executedToolMetadata: executed === undefined ? 'absent' : 'present' };
};

export const createCodexRolloutHostExchange = ({ controlRoot, dataRoot, codexSessionId, codexHome, stateDbPath, expectedCwd = process.cwd(), output = process.stdout, onRejected = null, responseTimeoutMs = 120000, pollMs = 250, requestReminderMs = 30000, locate = locateCodexRollout } = {}) => {
  if (!safeId(codexSessionId) || !Number.isSafeInteger(responseTimeoutMs) || responseTimeoutMs < 1 || !Number.isSafeInteger(pollMs) || pollMs < 1 || !Number.isSafeInteger(requestReminderMs) || requestReminderMs < 1) fail('CODEX_ROLLOUT_EXCHANGE_CONFIG_INVALID', 'Rollout Host exchange requires a session and positive timeouts.');
  const receiptRoot = assertHarnessWritePath(resolve(dataRoot, 'host-bridge', 'rollout-receipts'), 'Codex rollout Host receipts', controlRoot);
  const consumedCalls = new Set();
  let closed = false;
  const reject = async (code, message, request, progress = {}) => {
    closed = true;
    const details = { requestId: request.requestId, requestDigest: request.requestDigest, operation: request.operation, tool: request.tool, rawFrameDigest: sha256(''), rawFrameBytes: 0, observedFields: [], mismatchedFields: [], ...progress };
    if (typeof onRejected === 'function') {
      try { details.diagnostic = await onRejected({ code, message, request, rawLine: '', ...details }); }
      catch (error) { details.diagnosticError = { code: error.code ?? 'CODEX_HOST_DIAGNOSTIC_WRITE_FAILED', message: error.message }; }
    }
    throw Object.assign(new Error(message), { code, details });
  };
  return Object.freeze({
    machineBoundResults: true,
    async exchange(request) {
      if (closed) fail('CODEX_ROLLOUT_EXCHANGE_CLOSED', 'Rollout Host exchange is closed.');
      validateRequest(request, codexSessionId);
      const host = await locate({ codexHome, codexSessionId, expectedCwd, stateDbPath });
      const handle = await open(host.path, 'r');
      try {
        let cursor = (await handle.stat()).size;
        const startCursor = cursor;
        let reminders = 0;
        if (cursor > 0) {
          const last = Buffer.alloc(1);
          await handle.read(last, 0, 1, cursor - 1);
          if (last[0] !== 10) fail('CODEX_ROLLOUT_NOT_LINE_ALIGNED', 'Codex rollout is not at a complete JSON line before the Host request.');
        }
        const calls = new Map();
        let partial = '';
        const decoder = new StringDecoder('utf8');
        output.write(`${JSON.stringify(request)}\n`);
        const deadline = Date.now() + responseTimeoutMs;
        let nextReminder = Date.now() + requestReminderMs;
        while (Date.now() < deadline) {
          if (closed) fail('CODEX_ROLLOUT_EXCHANGE_CLOSED', 'Rollout Host exchange was closed.');
          const current = await locate({ codexHome, codexSessionId, expectedCwd, stateDbPath });
          if (!samePath(current.path, host.path)) await reject('CODEX_ROLLOUT_PATH_CHANGED', 'Codex changed the active rollout during a pending Host request.', request);
          const size = (await stat(host.path)).size;
          if (size < cursor) await reject('CODEX_ROLLOUT_TRUNCATED', 'Codex rollout was truncated during a pending Host request.', request);
          while (cursor < size) {
            const buffer = Buffer.alloc(Math.min(65536, size - cursor));
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, cursor);
            if (!bytesRead) break;
            cursor += bytesRead;
            partial += decoder.write(buffer.subarray(0, bytesRead));
            if (Buffer.byteLength(partial) > 8 * 1024 * 1024) await reject('CODEX_ROLLOUT_LINE_TOO_LARGE', 'Codex rollout native event exceeds the local Host limit.', request);
            let newline;
            while ((newline = partial.indexOf('\n')) >= 0) {
              const line = partial.slice(0, newline);
              partial = partial.slice(newline + 1);
              if (!line) continue;
              const native = parseNativeLine(line, request, calls);
              if (!native) continue;
              if (consumedCalls.has(native.callId)) await reject('CODEX_ROLLOUT_CALL_REPLAYED', 'Native Codex call ID was already consumed.', request);
              consumedCalls.add(native.callId);
              const receipt = { protocolVersion: '1.0', kind: 'codex-rollout-host-receipt', sessionId: codexSessionId, requestId: request.requestId, requestDigest: request.requestDigest, argumentsDigest: digestJson(request.arguments), argumentAttestation: native.argumentAttestation, executedToolMetadata: native.executedToolMetadata, tool: request.tool, callId: native.callId, outputId: native.outputId, turnId: native.turnId, ordinal: native.ordinal, resultDigest: digestJson(native.result), rolloutPathDigest: sha256(host.path), codexVersion: host.cliVersion, observedAt: new Date().toISOString() };
              await atomicWriteJson(resolve(receiptRoot, `${request.requestId}-${randomUUID()}.json`), { ...receipt, receiptDigest: digestJson(receipt) }, { root: controlRoot });
              return structuredClone(createHostResponseEnvelope(request, native.result).result);
            }
          }
          if (Date.now() >= nextReminder) { output.write(`${JSON.stringify(request)}\n`); reminders += 1; nextReminder = Date.now() + requestReminderMs; }
          await delay(pollMs);
        }
        await reject('CODEX_ROLLOUT_RESPONSE_TIMEOUT', 'No bound native Codex result appeared in the current session rollout before timeout.', request, { observedRolloutBytes: cursor - startCursor, matchingNativeCalls: calls.size, reminders });
      } finally { await handle.close(); }
    },
    close() { closed = true; },
  });
};
