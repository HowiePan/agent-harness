import { randomUUID } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { StringDecoder } from 'node:string_decoder';
import { digestJson, sha256 } from '../../../../src/common/canonical.mjs';
import { assertHarnessWritePath } from '../../../../src/common/write-boundary.mjs';
import { atomicWriteJson } from '../../../../src/kernel/atomic-io.mjs';
import { createHostResponseEnvelope } from './stdio-host-exchange.mjs';

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
  let row;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try { row = database.prepare('SELECT id, rollout_path, cwd, cli_version FROM threads WHERE id = ?').get(codexSessionId); }
  finally { database.close(); }
  if (!row || row.id !== codexSessionId || !samePath(row.cwd, expectedCwd)) fail('CODEX_ROLLOUT_SESSION_NOT_BOUND', 'Codex state database does not bind this session to the current workspace.');
  const path = await realpath(normalizeHostPath(row.rollout_path));
  if (!inside(join(home, 'sessions'), path) || !path.toLowerCase().endsWith('.jsonl') || !path.includes(codexSessionId)) fail('CODEX_ROLLOUT_PATH_INVALID', 'Codex rollout path is not bound to this session under CODEX_HOME.');
  return { path, cliVersion: row.cli_version, codexHome: home };
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

export const createCodexRolloutHostExchange = ({ controlRoot, dataRoot, codexSessionId, codexHome, stateDbPath, expectedCwd = process.cwd(), output = process.stdout, onRejected = null, responseTimeoutMs = 120000, pollMs = 50, requestReminderMs = 5000, locate = locateCodexRollout } = {}) => {
  if (!safeId(codexSessionId) || !Number.isSafeInteger(responseTimeoutMs) || responseTimeoutMs < 1 || !Number.isSafeInteger(pollMs) || pollMs < 1 || !Number.isSafeInteger(requestReminderMs) || requestReminderMs < 1) fail('CODEX_ROLLOUT_EXCHANGE_CONFIG_INVALID', 'Rollout Host exchange requires a session and positive timeouts.');
  const receiptRoot = assertHarnessWritePath(resolve(dataRoot, 'host-bridge', 'rollout-receipts'), 'Codex rollout Host receipts', controlRoot);
  const consumedCalls = new Set();
  let closed = false;
  const reject = async (code, message, request) => {
    closed = true;
    const details = { requestId: request.requestId, requestDigest: request.requestDigest, operation: request.operation, tool: request.tool, rawFrameDigest: sha256(''), rawFrameBytes: 0, observedFields: [], mismatchedFields: [] };
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
          if (Date.now() >= nextReminder) { output.write(`${JSON.stringify(request)}\n`); nextReminder = Date.now() + requestReminderMs; }
          await delay(pollMs);
        }
        await reject('CODEX_ROLLOUT_RESPONSE_TIMEOUT', 'No bound native Codex result appeared in the current session rollout before timeout.', request);
      } finally { await handle.close(); }
    },
    close() { closed = true; },
  });
};
