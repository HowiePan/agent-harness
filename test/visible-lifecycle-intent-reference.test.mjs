import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { harnessTemporaryRoot } from '../src/index.mjs';
import { createVisibleLifecycleIntent, encodeVisibleLifecycleIntent } from '../integrations/codex/agent-harness-codex/lib/visible-lifecycle-intent.mjs';
import { resolveVisibleLifecycleIntentArgument, storeVisibleLifecycleIntentReference } from '../integrations/codex/agent-harness-codex/lib/visible-lifecycle-intent-reference.mjs';

test('source-link intent reference is short, bound to its bytes, and reusable for a permitted retry', async t => {
  await mkdir(harnessTemporaryRoot(), { recursive: true });
  const dataRoot = await mkdtemp(resolve(harnessTemporaryRoot(), 'intent-ref-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const intent = createVisibleLifecycleIntent({
    harness: { controlRoot: dataRoot, dataRoot, entrypoint: resolve(dataRoot, 'harness.mjs'), release: {
      mode: 'source-link', version: '1.0.0', artifactDigest: 'a'.repeat(64), generationId: 'test', pointerDigest: 'b'.repeat(64),
    } },
    project: { projectId: 'test', profileId: 'profile', extensionId: 'extension' },
    command: { action: 'implement', target: 'V3.8.5', arguments: [] },
    executionWorkspaceRoot: dataRoot,
    coordinatorEntrypoint: resolve(dataRoot, 'coordinator.mjs'),
    codexSessionId: 'session-1',
  });
  const encodedIntent = encodeVisibleLifecycleIntent(intent);
  const reference = await storeVisibleLifecycleIntentReference({ encodedIntent, dataRoot });
  assert.match(reference, /^ref\./);
  assert.ok(reference.length < encodedIntent.length / 2);
  assert.deepEqual(await resolveVisibleLifecycleIntentArgument(reference), intent);
  assert.deepEqual(await resolveVisibleLifecycleIntentArgument(reference), intent);
  assert.deepEqual(await resolveVisibleLifecycleIntentArgument(encodedIntent), intent);
  await assert.rejects(() => resolveVisibleLifecycleIntentArgument(`${reference.slice(0, -1)}${reference.endsWith('a') ? 'b' : 'a'}`), { code: 'VISIBLE_LIFECYCLE_INTENT_REFERENCE_MISMATCH' });
  const recordFile = resolve(dataRoot, 'visible-intents', `${intent.commandId}.json`);
  const record = JSON.parse(await readFile(recordFile, 'utf8'));
  record.encodedIntent = record.encodedIntent.slice(0, -1);
  await writeFile(recordFile, JSON.stringify(record));
  await assert.rejects(() => resolveVisibleLifecycleIntentArgument(reference));
});
