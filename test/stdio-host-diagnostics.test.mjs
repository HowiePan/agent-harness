import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { assertMachineBoundQualityTransport, createHostResponseEnvelope, createStdioHostExchange } from '../integrations/codex/agent-harness-codex/lib/stdio-host-exchange.mjs';
import { createHostExchangeDiagnosticWriter } from '../integrations/codex/agent-harness-codex/lib/host-exchange-diagnostics.mjs';
import { harnessTemporaryRoot } from '../src/common/write-boundary.mjs';
import { digestJson, sha256 } from '../src/common/canonical.mjs';

const request = { protocolVersion: '1.0', kind: 'codex-visible-host-request', sessionId: 'session', requestId: 'request', requestDigest: 'a'.repeat(64), operation: 'inspect', tool: 'collaboration.list_agents', arguments: {}, binding: null, createdAt: '2026-09-20T00:00:00.000Z' };

test('Host JSON and request-binding failures leave replayable, bounded diagnostic receipts', async t => {
  const controlRoot = resolve(process.cwd());
  const parent = resolve(harnessTemporaryRoot(), 'stdio-host-diagnostics');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'case-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [line, code, mismatch] of [
    ['not JSON', 'CODEX_HOST_RESPONSE_JSON_INVALID', []],
    ['log line before JSON', 'CODEX_HOST_RESPONSE_JSON_INVALID', []],
    [JSON.stringify({ protocolVersion: '1.0', kind: 'codex-visible-host-response', sessionId: 'session', requestId: 'request', requestDigest: 'wrong', operation: 'inspect', tool: 'collaboration.list_agents', result: { agents: [] } }), 'CODEX_HOST_RESPONSE_BINDING_MISMATCH', ['requestDigest']],
  ]) {
    const input = new PassThrough();
    const output = new PassThrough();
    const exchange = createStdioHostExchange({ input, output, onRejected: createHostExchangeDiagnosticWriter({ controlRoot, dataRoot: root }) });
    const pending = exchange.exchange(request);
    await once(output, 'data');
    input.write(`${line}\n`);
    const error = await pending.then(() => assert.fail('Host response should have been rejected.'), caught => caught);
    assert.equal(error.code, code);
    assert.deepEqual(error.details.mismatchedFields, mismatch);
    const receipt = JSON.parse(await readFile(error.details.diagnostic.file, 'utf8'));
    assert.equal(receipt.code, code);
    assert.equal(receipt.rawFrameDigest, sha256(line));
    assert.equal(receipt.rawFrame, line);
    const { receiptDigest, ...body } = receipt;
    assert.equal(receiptDigest, digestJson(body));
    await assert.rejects(() => exchange.exchange(request), error => error.code === 'CODEX_HOST_EXCHANGE_CLOSED');
    exchange.close();
  }
});

test('Host envelope is built from the pending request and a timeout closes the exchange', async () => {
  const result = { agents: [] };
  const input = new PassThrough();
  const output = new PassThrough();
  const exchange = createStdioHostExchange({ input, output, responseTimeoutMs: 100 });
  const pending = exchange.exchange(request);
  await once(output, 'data');
  input.write(`${JSON.stringify(createHostResponseEnvelope(request, result))}\n`);
  assert.deepEqual(await pending, result);
  const later = { ...request, requestId: 'later' };
  const timedOut = exchange.exchange(later);
  await once(output, 'data');
  await assert.rejects(() => timedOut, error => error.code === 'CODEX_HOST_RESPONSE_TIMEOUT');
  input.write(`${JSON.stringify(createHostResponseEnvelope(later, result))}\n`);
  await assert.rejects(() => exchange.exchange(later), error => error.code === 'CODEX_HOST_EXCHANGE_CLOSED');
  exchange.close();
});

test('quality actions fail before Run start when the Host result still needs manual transcription', () => {
  const exchange = createStdioHostExchange({ input: new PassThrough(), output: new PassThrough() });
  assert.equal(exchange.machineBoundResults, false);
  for (const action of ['quality', 'full', 'deliver']) assert.throws(
    () => assertMachineBoundQualityTransport(exchange, action),
    error => error.code === 'CODEX_HOST_MACHINE_BRIDGE_UNAVAILABLE',
  );
  assert.doesNotThrow(() => assertMachineBoundQualityTransport(exchange, 'plan'));
  exchange.close();
});
