import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { digestJson } from '../src/common/canonical.mjs';
import { harnessTemporaryRoot } from '../src/common/write-boundary.mjs';
import { resolveCodexThread } from '../integrations/codex/agent-harness-codex/lib/codex-rollout-locator.mjs';
import { createCodexRolloutHostExchange } from '../integrations/codex/agent-harness-codex/lib/codex-rollout-host-exchange.mjs';

const id = '01a13529-8f80-7720-8b3b-ff358ebac400';
const setup = async t => {
  await mkdir(harnessTemporaryRoot(), { recursive: true });
  const home = await mkdtemp(resolve(harnessTemporaryRoot(), 'rollout-locator-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const day = resolve(home, 'sessions/2026/10/13');
  await mkdir(day, { recursive: true });
  const path = resolve(day, 'rollout-2026-10-13T00-00-00-' + id + '.jsonl');
  const bytes = JSON.stringify({ type: 'session_meta', payload: { id, cwd: process.cwd(), cli_version: 'obsolete-codex' } }) + '\n';
  await writeFile(path, bytes);
  return { codexHome: home, codexSessionId: id, expectedCwd: process.cwd(), path, bytes };
};

test('live location never waits on an obsolete original rollout when the current database is unavailable', async t => {
  const input = await setup(t);
  let closed = false;
  const cause = Object.assign(new Error('unable to open database file'), { code: 'ERR_SQLITE_ERROR', errcode: 14 });
  class Unavailable {
    constructor(path, options) { assert.equal(options.readOnly, true); }
    prepare() { throw cause; }
    close() { closed = true; }
  }
  const options = { ...input, Database: Unavailable };
  await assert.rejects(resolveCodexThread(options), error => {
    assert.equal(error.code, 'CODEX_ROLLOUT_DATABASE_UNAVAILABLE');
    assert.equal(error.cause, cause);
    return true;
  });
  assert.equal(closed, true);
  assert.equal(await readFile(input.path, 'utf8'), input.bytes);

  // Failure precedes the Host request and cannot spend the 30-minute result wait.
  const output = new PassThrough();
  let emitted = '';
  output.on('data', chunk => { emitted += chunk; });
  const exchange = createCodexRolloutHostExchange({ controlRoot: process.cwd(), dataRoot: input.codexHome,
    codexSessionId: id, output, locate: () => resolveCodexThread(options) });
  const body = { protocolVersion: '1.0', kind: 'codex-visible-host-request', tool: 'collaboration.list_agents',
    arguments: {}, sessionId: id, requestId: 'unavailable-database', operation: 'inspect', binding: null, createdAt: new Date().toISOString() };
  await assert.rejects(exchange.exchange({ ...body, requestDigest: digestJson(body) }), { code: 'CODEX_ROLLOUT_DATABASE_UNAVAILABLE' });
  exchange.close();
  assert.equal(emitted, '');
});

test('the read-only database selects the current paginated file instead of the original UUID day', async () => {
  const row = { id, rollout_path: 'sessions/2026/10/23/current-paginated.jsonl', cwd: process.cwd(), cli_version: 'current-codex' };
  let closed = false;
  class Available {
    constructor(path, options) { assert.equal(options.readOnly, true); }
    prepare(sql) {
      assert.equal(sql, 'SELECT id, rollout_path, cwd, cli_version FROM threads WHERE id = ?');
      return { get: session => { assert.equal(session, id); return row; } };
    }
    close() { closed = true; }
  }
  assert.deepEqual(await resolveCodexThread({ databasePath: 'bound-database', codexSessionId: id, Database: Available }), { row });
  assert.equal(closed, true);
  class Missing extends Available { prepare() { return { get: () => undefined }; } }
  assert.deepEqual(await resolveCodexThread({ Database: Missing }), { row: undefined });
});

test('corruption and other database failures are preserved and never become a metadata fallback', async () => {
  for (const cause of [Object.assign(new Error('corrupt'), { code: 'ERR_SQLITE_ERROR', errcode: 11 }), new Error('other failure')]) {
    let closed = false;
    class Corrupt {
      prepare() { throw cause; }
      close() { closed = true; }
    }
    await assert.rejects(resolveCodexThread({ Database: Corrupt }), error => error === cause);
    assert.equal(closed, true);
  }
});
