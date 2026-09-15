import { createInterface } from 'node:readline';

const fail = (code, message, cause) => {
  throw Object.assign(new Error(message, cause ? { cause } : undefined), { code });
};

export const createStdioHostExchange = ({ input = process.stdin, output = process.stdout } = {}) => {
  const lines = createInterface({ input, crlfDelay: Infinity })[Symbol.asyncIterator]();
  const consumed = new Set();
  let closed = false;

  return Object.freeze({
    async exchange(request) {
      if (closed) fail('CODEX_HOST_EXCHANGE_CLOSED', 'Codex Host exchange is closed.');
      output.write(`${JSON.stringify(request)}\n`);
      const next = await lines.next();
      if (next.done) {
        closed = true;
        fail('CODEX_HOST_RESPONSE_MISSING', 'Codex Host exchange closed before the pending response arrived.');
      }
      let response;
      try { response = JSON.parse(next.value); }
      catch (error) { fail('CODEX_HOST_RESPONSE_JSON_INVALID', 'Codex Host response must be one strict JSON line.', error); }
      if (!response || typeof response !== 'object' || Array.isArray(response)) fail('CODEX_HOST_RESPONSE_INVALID', 'Codex Host response envelope is invalid.');
      const allowed = ['protocolVersion', 'kind', 'sessionId', 'requestId', 'requestDigest', 'operation', 'tool', 'result'];
      if (Object.keys(response).some(key => !allowed.includes(key)) || allowed.some(key => !Object.hasOwn(response, key))) fail('CODEX_HOST_RESPONSE_INVALID', 'Codex Host response envelope has missing or unexpected fields.');
      if (response.protocolVersion !== '1.0' || response.kind !== 'codex-visible-host-response') fail('CODEX_HOST_RESPONSE_PROTOCOL_INVALID', 'Codex Host response protocol is invalid.');
      for (const key of ['sessionId', 'requestId', 'requestDigest', 'operation', 'tool']) if (response[key] !== request[key]) fail('CODEX_HOST_RESPONSE_BINDING_MISMATCH', `Codex Host response ${key} does not match the pending request.`);
      if (consumed.has(response.requestId)) fail('CODEX_HOST_RESPONSE_REPLAYED', 'Codex Host response request ID was already consumed.');
      if (!response.result || typeof response.result !== 'object' || Array.isArray(response.result)) fail('CODEX_HOST_TOOL_RESULT_INVALID', 'Codex Host response must preserve the native tool result object.');
      consumed.add(response.requestId);
      return structuredClone(response.result);
    },
    close() {
      closed = true;
      lines.return?.();
    },
  });
};
