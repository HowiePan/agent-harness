#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestJson } from '../../../../src/common/canonical.mjs';
import { loadLocalSourceBindings } from '../hooks/local-source-hook.mjs';
import { createHookHostExchange } from '../lib/hook-host-exchange.mjs';
import { createHostExchangeDiagnosticWriter } from '../lib/host-exchange-diagnostics.mjs';

export const runLocalSourceHostProbe = async ({ bindingsDir, sessionId, output = process.stdout, responseTimeoutMs = 60000 } = {}) => {
  if (typeof sessionId !== 'string' || !sessionId.length) throw Object.assign(new Error('Local Host probe requires the current Codex session ID.'), { code: 'LOCAL_SOURCE_HOST_PROBE_SESSION_REQUIRED' });
  const { bindings } = await loadLocalSourceBindings(bindingsDir);
  const { controlRoot, dataRoot } = bindings.harness;
  const exchange = createHookHostExchange({ controlRoot, dataRoot, codexSessionId: sessionId, output, responseTimeoutMs, onRejected: createHostExchangeDiagnosticWriter({ controlRoot, dataRoot }) });
  const body = { protocolVersion: '1.0', kind: 'codex-visible-host-request', tool: 'collaboration.list_agents', arguments: {}, sessionId, requestId: `host_probe_${randomUUID()}`, operation: 'inspect', binding: null, createdAt: new Date().toISOString() };
  const request = { ...body, requestDigest: digestJson(body) };
  try {
    const result = await exchange.exchange(request);
    if (!Array.isArray(result?.agents)) throw Object.assign(new Error('Native list_agents result does not contain an agents array.'), { code: 'LOCAL_SOURCE_HOST_PROBE_RESULT_INVALID' });
    return { protocolVersion: '1.0', kind: 'local-source-host-probe-result', ok: true, requestId: request.requestId, requestDigest: request.requestDigest, resultDigest: digestJson(result), agentCount: result.agents.length };
  } finally { exchange.close(); }
};

const main = async () => {
  if (process.argv.length !== 6 || process.argv[2] !== '--bindings-dir' || process.argv[4] !== '--session-id') throw Object.assign(new Error('Usage: local-source-host-probe.mjs --bindings-dir <absolute-dir> --session-id <current-session-id>'), { code: 'LOCAL_SOURCE_HOST_PROBE_ARGUMENTS_INVALID' });
  process.stdout.write(`${JSON.stringify(await runLocalSourceHostProbe({ bindingsDir: process.argv[3], sessionId: process.argv[5] }))}\n`);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${JSON.stringify({ protocolVersion: '1.0', kind: 'local-source-host-probe-result', ok: false, code: error.code ?? 'UNEXPECTED_ERROR', message: error.message, diagnostic: error.details?.diagnostic ?? null })}\n`);
    process.exitCode = 1;
  });
}
