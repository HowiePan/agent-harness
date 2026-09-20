import { createInterface } from 'node:readline';
import { sha256 } from '../../../../src/common/canonical.mjs';

const fail = (code, message, cause) => {
  throw Object.assign(new Error(message, cause ? { cause } : undefined), { code });
};

export const createHostResponseEnvelope = (request, result) => ({
  protocolVersion: '1.0', kind: 'codex-visible-host-response',
  sessionId: request.sessionId, requestId: request.requestId, requestDigest: request.requestDigest,
  operation: request.operation, tool: request.tool, result: structuredClone(result),
});

export const assertMachineBoundQualityTransport = (exchange, action) => {
  if (['quality', 'full', 'deliver'].includes(action) && exchange.machineBoundResults !== true) fail('CODEX_HOST_MACHINE_BRIDGE_UNAVAILABLE', 'Quality lifecycle requires a Host bridge that binds the native tool result to the pending request without manual frame transcription.');
};

export const createStdioHostExchange = ({ input = process.stdin, output = process.stdout, onRejected = null, responseTimeoutMs = 120000 } = {}) => {
  if (!Number.isSafeInteger(responseTimeoutMs) || responseTimeoutMs < 1) fail('CODEX_HOST_TIMEOUT_INVALID', 'Codex Host response timeout must be a positive integer.');
  const lines = createInterface({ input, crlfDelay: Infinity })[Symbol.asyncIterator]();
  const consumed = new Set();
  let closed = false;
  const reject = async (code, message, request, rawLine, observed = null, cause = null) => {
    closed = true;
    const frame = typeof rawLine === 'string' ? rawLine : '';
    const details = {
      requestId: request.requestId,
      requestDigest: request.requestDigest,
      operation: request.operation,
      tool: request.tool,
      rawFrameDigest: sha256(frame),
      rawFrameBytes: Buffer.byteLength(frame),
      observedFields: observed && typeof observed === 'object' && !Array.isArray(observed) ? Object.keys(observed).sort() : [],
      mismatchedFields: observed && typeof observed === 'object' && !Array.isArray(observed)
        ? ['sessionId', 'requestId', 'requestDigest', 'operation', 'tool'].filter(key => observed[key] !== request[key]) : [],
    };
    if (typeof onRejected === 'function') {
      try { details.diagnostic = await onRejected({ code, message, request, rawLine: frame, ...details }); }
      catch (error) { details.diagnosticError = { code: error.code ?? 'CODEX_HOST_DIAGNOSTIC_WRITE_FAILED', message: error.message }; }
    }
    throw Object.assign(new Error(message, cause ? { cause } : undefined), { code, details });
  };

  return Object.freeze({
    machineBoundResults: false,
    async exchange(request) {
      if (closed) fail('CODEX_HOST_EXCHANGE_CLOSED', 'Codex Host exchange is closed.');
      output.write(`${JSON.stringify(request)}\n`);
      let timer;
      const next = await Promise.race([
        lines.next(),
        new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), responseTimeoutMs); }),
      ]).finally(() => clearTimeout(timer));
      if (next.timedOut) await reject('CODEX_HOST_RESPONSE_TIMEOUT', 'Codex Host response timed out; exchange is closed to prevent a late frame from binding to another request.', request, '');
      if (next.done) {
        closed = true;
        await reject('CODEX_HOST_RESPONSE_MISSING', 'Codex Host exchange closed before the pending response arrived.', request, '');
      }
      let response;
      try { response = JSON.parse(next.value); }
      catch (error) { await reject('CODEX_HOST_RESPONSE_JSON_INVALID', 'Codex Host response must be one strict JSON line.', request, next.value, null, error); }
      if (!response || typeof response !== 'object' || Array.isArray(response)) await reject('CODEX_HOST_RESPONSE_INVALID', 'Codex Host response envelope is invalid.', request, next.value, response);
      const allowed = ['protocolVersion', 'kind', 'sessionId', 'requestId', 'requestDigest', 'operation', 'tool', 'result'];
      if (Object.keys(response).some(key => !allowed.includes(key)) || allowed.some(key => !Object.hasOwn(response, key))) await reject('CODEX_HOST_RESPONSE_INVALID', 'Codex Host response envelope has missing or unexpected fields.', request, next.value, response);
      if (response.protocolVersion !== '1.0' || response.kind !== 'codex-visible-host-response') await reject('CODEX_HOST_RESPONSE_PROTOCOL_INVALID', 'Codex Host response protocol is invalid.', request, next.value, response);
      for (const key of ['sessionId', 'requestId', 'requestDigest', 'operation', 'tool']) if (response[key] !== request[key]) await reject('CODEX_HOST_RESPONSE_BINDING_MISMATCH', `Codex Host response ${key} does not match the pending request.`, request, next.value, response);
      if (consumed.has(response.requestId)) await reject('CODEX_HOST_RESPONSE_REPLAYED', 'Codex Host response request ID was already consumed.', request, next.value, response);
      if (!response.result || typeof response.result !== 'object' || Array.isArray(response.result)) await reject('CODEX_HOST_TOOL_RESULT_INVALID', 'Codex Host response must preserve the native tool result object.', request, next.value, response);
      consumed.add(response.requestId);
      return structuredClone(response.result);
    },
    close() {
      closed = true;
      lines.return?.();
    },
  });
};
