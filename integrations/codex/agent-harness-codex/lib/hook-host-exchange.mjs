import { mkdir, readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digestJson, sha256 } from '../../../../src/common/canonical.mjs';
import { assertHarnessWritePath } from '../../../../src/common/write-boundary.mjs';
import { atomicWriteJson, readJson } from '../../../../src/kernel/atomic-io.mjs';
import { createHostResponseEnvelope } from './stdio-host-exchange.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const delay = ms => new Promise(done => setTimeout(done, ms));
const allowedTools = new Set(['collaboration.spawn_agent', 'collaboration.list_agents', 'collaboration.wait_agent', 'collaboration.interrupt_agent']);
const hookToolName = (name, requested) => name === requested || name === 'Agent' && requested === 'collaboration.spawn_agent';
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const toolUseId = value => typeof value === 'string' && value.length > 0 && value.length <= 256;

export const createHookHostExchange = ({ controlRoot, dataRoot, codexSessionId, output = process.stdout, onRejected = null, responseTimeoutMs = 120000, pollMs = 50, now = () => new Date().toISOString() }) => {
  if (!Number.isSafeInteger(responseTimeoutMs) || responseTimeoutMs < 1 || !Number.isSafeInteger(pollMs) || pollMs < 1) fail('CODEX_HOST_TIMEOUT_INVALID', 'Hook Host exchange requires positive timeouts.');
  if (typeof codexSessionId !== 'string' || !codexSessionId.length) fail('CODEX_HOST_SESSION_BINDING_REQUIRED', 'Hook Host exchange requires the parent Codex session ID.');
  const root = assertHarnessWritePath(resolve(dataRoot, 'host-bridge'), 'Codex Hook Host bridge', controlRoot);
  const pendingRoot = assertHarnessWritePath(resolve(root, 'pending'), 'Codex Hook Host pending requests', controlRoot);
  const seenToolUseIds = new Set();
  let closed = false;
  const reject = async (code, message, request, observed = null) => {
    closed = true;
    const rawLine = observed ? JSON.stringify(observed) : '';
    const details = { requestId: request.requestId, requestDigest: request.requestDigest, operation: request.operation, tool: request.tool, rawFrameDigest: sha256(rawLine), rawFrameBytes: Buffer.byteLength(rawLine), observedFields: observed && typeof observed === 'object' ? Object.keys(observed).sort() : [], mismatchedFields: [] };
    if (typeof onRejected === 'function') {
      try { details.diagnostic = await onRejected({ code, request, rawLine, ...details }); }
      catch (error) { details.diagnosticError = { code: error.code ?? 'CODEX_HOST_DIAGNOSTIC_WRITE_FAILED', message: error.message }; }
    }
    throw Object.assign(new Error(message), { code, details });
  };
  return Object.freeze({
    machineBoundResults: true,
    async exchange(request) {
      if (closed) fail('CODEX_HOST_EXCHANGE_CLOSED', 'Codex Hook Host exchange is closed.');
      if (!safeId(request?.requestId) || !allowedTools.has(request?.tool)) fail('CODEX_HOST_REQUEST_INVALID', 'Hook Host request identity or tool is invalid.');
      const { requestDigest, ...body } = request;
      if (requestDigest !== digestJson(body)) fail('CODEX_HOST_REQUEST_DIGEST_MISMATCH', 'Hook Host request digest is invalid.');
      const file = assertHarnessWritePath(resolve(pendingRoot, `${request.requestId}.json`), 'Codex Hook Host pending request', controlRoot);
      const responseFile = assertHarnessWritePath(resolve(pendingRoot, `${request.requestId}.response.json`), 'Codex Hook Host response', controlRoot);
      await mkdir(pendingRoot, { recursive: true });
      await atomicWriteJson(file, { request, requestDigest, argumentsDigest: digestJson(request.arguments), codexSessionId, expiresAt: new Date(Date.parse(now()) + responseTimeoutMs).toISOString() }, { root });
      output.write(`${JSON.stringify(request)}\n`);
      const deadline = Date.now() + responseTimeoutMs;
      while (Date.now() < deadline) {
        const reply = await readJson(responseFile, null);
        if (reply) {
          if (reply.requestDigest !== requestDigest || reply.tool !== request.tool || reply.argumentsDigest !== digestJson(request.arguments) || reply.hookSessionId !== codexSessionId || !toolUseId(reply.toolUseId) || seenToolUseIds.has(reply.toolUseId) || !reply.result || typeof reply.result !== 'object' || Array.isArray(reply.result)) await reject('CODEX_HOST_HOOK_RESPONSE_INVALID', 'Hook Host response is not bound to the pending native tool call.', request, reply);
          seenToolUseIds.add(reply.toolUseId);
          return structuredClone(createHostResponseEnvelope(request, reply.result).result);
        }
        await delay(pollMs);
      }
      await reject('CODEX_HOST_HOOK_RESPONSE_TIMEOUT', 'No verified PostToolUse result reached the pending Host request before timeout.', request);
    },
    close() { closed = true; },
  });
};

export const captureHookToolResult = async (event, { controlRoot, dataRoot, now = () => new Date().toISOString() }) => {
  if (event?.hook_event_name !== 'PostToolUse' || typeof event.tool_name !== 'string' || !toolUseId(event.tool_use_id) || !event.tool_input || !event.tool_response) return { captured: false, reasonCode: 'CODEX_HOST_HOOK_EVENT_INVALID' };
  const root = assertHarnessWritePath(resolve(dataRoot, 'host-bridge'), 'Codex Hook Host bridge', controlRoot);
  const pendingRoot = assertHarnessWritePath(resolve(root, 'pending'), 'Codex Hook Host pending requests', controlRoot);
  let names;
  try { names = await readdir(pendingRoot); }
  catch (error) { if (error.code === 'ENOENT') return { captured: false, reasonCode: 'CODEX_HOST_HOOK_PENDING_ROOT_MISSING' }; throw error; }
  const matches = [];
  for (const name of names.filter(item => item.endsWith('.json') && !item.endsWith('.response.json'))) {
    const file = assertHarnessWritePath(resolve(pendingRoot, name), 'Codex Hook Host pending request', controlRoot);
    const pending = JSON.parse(await readFile(file, 'utf8'));
    const request = pending.request;
    if (!safeId(request?.requestId) || !allowedTools.has(request?.tool) || !hookToolName(event.tool_name, request.tool) || pending.codexSessionId !== event.session_id || Date.parse(pending.expiresAt) <= Date.parse(now()) || pending.requestDigest !== request.requestDigest || pending.argumentsDigest !== digestJson(event.tool_input)) continue;
    if (await readJson(resolve(pendingRoot, `${request.requestId}.response.json`), null)) continue;
    matches.push({ request, pending });
  }
  if (matches.length > 1) fail('CODEX_HOST_HOOK_REQUEST_AMBIGUOUS', 'A native tool result matches more than one pending Host request.');
  if (!matches.length) return { captured: false, reasonCode: 'CODEX_HOST_HOOK_PENDING_NOT_MATCHED' };
  if (typeof event.tool_response !== 'object' || Array.isArray(event.tool_response)) fail('CODEX_HOST_HOOK_RESULT_INVALID', 'Native Hook tool_response must be an object.');
  const { request, pending } = matches[0];
  const responseFile = assertHarnessWritePath(resolve(pendingRoot, `${request.requestId}.response.json`), 'Codex Hook Host response', controlRoot);
  const response = { requestDigest: request.requestDigest, tool: request.tool, argumentsDigest: pending.argumentsDigest, toolUseId: event.tool_use_id, hookSessionId: event.session_id ?? null, hookTurnId: event.turn_id ?? null, result: structuredClone(event.tool_response) };
  await atomicWriteJson(responseFile, response, { root });
  return { captured: true, requestId: request.requestId, toolUseId: event.tool_use_id };
};
