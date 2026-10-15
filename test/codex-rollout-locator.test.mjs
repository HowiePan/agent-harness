import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { harnessTemporaryRoot } from '../src/common/write-boundary.mjs';
import { locateCodexRolloutFromMetadata, resolveCodexThreadWithMetadata } from '../integrations/codex/agent-harness-codex/lib/codex-rollout-locator.mjs';

const id = '01a13529-8f80-7720-8b3b-ff358ebac400';
const setup = async t => {
  await mkdir(harnessTemporaryRoot(), { recursive: true });
  const home = await mkdtemp(resolve(harnessTemporaryRoot(), 'rollout-locator-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const day = resolve(home, 'sessions/2026/10/13');
  await mkdir(day, { recursive: true });
  const path = resolve(day, `rollout-2026-10-13T00-00-00-${id}.jsonl`);
  const metadata = { type: 'session_meta', payload: { id, cwd: process.cwd(), cli_version: 'fixture-codex' } };
  const bytes = JSON.stringify(metadata) + '\n';
  await writeFile(path, bytes);
  return { codexHome: home, codexSessionId: id, expectedCwd: process.cwd(), path, day, metadata, bytes };
};

test('native metadata binds only one exact current UUIDv7 rollout without writes', async t => {
  const input = await setup(t);
  assert.equal((await locateCodexRolloutFromMetadata(input)).path, input.path);
  assert.equal(await readFile(input.path, 'utf8'), input.bytes);
  await assert.rejects(locateCodexRolloutFromMetadata({ ...input, expectedCwd: resolve(input.expectedCwd, 'other') }),
    { code: 'CODEX_ROLLOUT_SESSION_NOT_BOUND' });
  await writeFile(resolve(input.day, `rollout-duplicate-${id}.jsonl`), input.bytes);
  await assert.rejects(locateCodexRolloutFromMetadata(input), { code: 'CODEX_ROLLOUT_METADATA_AMBIGUOUS' });
});

test('native metadata rejects an unbound, malformed or oversized header and non-UUID session', async t => {
  const input = await setup(t);
  for (const bytes of [
    JSON.stringify({ ...input.metadata, payload: { ...input.metadata.payload, id: 'other' } }) + '\n',
    JSON.stringify({ ...input.metadata, type: 'response_item' }) + '\n',
    JSON.stringify({ ...input.metadata, payload: { ...input.metadata.payload, cli_version: '' } }) + '\n',
  ]) {
    await writeFile(input.path, bytes);
    await assert.rejects(locateCodexRolloutFromMetadata(input), { code: 'CODEX_ROLLOUT_SESSION_NOT_BOUND' });
  }
  for (const bytes of ['not json\n', 'x'.repeat(65536) + '\n']) {
    await writeFile(input.path, bytes);
    await assert.rejects(locateCodexRolloutFromMetadata(input), { code: 'CODEX_ROLLOUT_METADATA_INVALID' });
  }
  await assert.rejects(locateCodexRolloutFromMetadata({ ...input, codexSessionId: '../other' }),
    { code: 'CODEX_ROLLOUT_METADATA_SESSION_INVALID' });
});

test('metadata fallback is limited to SQLITE_CANTOPEN and never overrides a readable database', async t => {
  const input = await setup(t);
  class Unavailable {
    constructor(path, options) { assert.equal(options.readOnly, true); }
    prepare() { throw Object.assign(new Error('unable to open database file'), { code: 'ERR_SQLITE_ERROR', errcode: 14 }); }
    close() {}
  }
  assert.equal((await resolveCodexThreadWithMetadata({ ...input, Database: Unavailable })).host.path, input.path);
  class Missing extends Unavailable { prepare() { return { get: () => undefined }; } }
  assert.deepEqual(await resolveCodexThreadWithMetadata({ ...input, Database: Missing }), { row: undefined });
  class Corrupt extends Unavailable { prepare() { throw Object.assign(new Error('corrupt'), { code: 'ERR_SQLITE_ERROR', errcode: 11 }); } }
  await assert.rejects(resolveCodexThreadWithMetadata({ ...input, Database: Corrupt }), { errcode: 11 });
});
