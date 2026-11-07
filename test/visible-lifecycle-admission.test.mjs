import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { harnessTemporaryRoot } from '../src/common/write-boundary.mjs';
import { createVisibleLifecycleIntent, encodeVisibleLifecycleIntent, decodeVisibleLifecycleIntent,
  validateVisibleLifecycleIntent, visibleLifecycleIntentDigest } from '../integrations/codex/agent-harness-codex/lib/visible-lifecycle-intent.mjs';
import { storeVisibleLifecycleIntentReference, resolveVisibleLifecycleIntentArgument } from '../integrations/codex/agent-harness-codex/lib/visible-lifecycle-intent-reference.mjs';

const input = root => ({ harness: { controlRoot: root, dataRoot: root, entrypoint: resolve(root, 'harness.mjs'),
  release: { version: '1.0.0', artifactDigest: 'a'.repeat(64), generationId: 'g1', pointerDigest: 'b'.repeat(64) } },
  project: { projectId: 'isolated', profileId: 'fixture', extensionId: 'fixture' },
  command: { action: 'implement', target: 'V-next', arguments: [] }, executionWorkspaceRoot: root,
  coordinatorEntrypoint: resolve(root, 'coordinator.mjs'), codexSessionId: 'native-session', admissionPolicy: 'native-current-command/1' });

test('native routing envelope survives long preparation without renewal; legacy envelopes retain expiry', async t => {
  await mkdir(harnessTemporaryRoot(), { recursive: true });
  const root = await mkdtemp(resolve(harnessTemporaryRoot(), 'admission-')); t.after(() => rm(root, { recursive: true, force: true }));
  const at = '2026-09-15T00:00:00.000Z', later = () => '2026-09-15T02:00:00.000Z';
  const native = createVisibleLifecycleIntent({ ...input(root), now: () => at });
  assert.equal(native.expiresAt, undefined);
  assert.deepEqual(decodeVisibleLifecycleIntent(encodeVisibleLifecycleIntent(native), { now: later }), native);
  // Reference resolution uses the real later clock; it must preserve the exact
  // original command/digest rather than minting or extending an intent.
  const ref = await storeVisibleLifecycleIntentReference({ encodedIntent: encodeVisibleLifecycleIntent(native), dataRoot: root });
  assert.deepEqual(await resolveVisibleLifecycleIntentArgument(ref), native);
  const legacy = createVisibleLifecycleIntent({ ...input(root), admissionPolicy: null, now: () => at });
  assert.throws(() => validateVisibleLifecycleIntent(legacy, { now: later }), { code: 'VISIBLE_LIFECYCLE_INTENT_EXPIRED' });
});

test('native admission rejects malformed policies, session loss, future time, and digest changes', () => {
  const at = '2026-09-15T00:00:00.000Z', options = { now: () => at }, native = createVisibleLifecycleIntent({ ...input(harnessTemporaryRoot()), ...options });
  assert.throws(() => createVisibleLifecycleIntent({ ...input(harnessTemporaryRoot()), codexSessionId: null }), { code: 'VISIBLE_LIFECYCLE_ADMISSION_POLICY_INVALID' });
  for (const patch of [{ admissionPolicy: 'anything' }, { codexSessionId: undefined }, { expiresAt: at }]) {
    const value = { ...native, ...patch };
    for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
    value.intentDigest = visibleLifecycleIntentDigest(value);
    assert.throws(() => validateVisibleLifecycleIntent(value, options), { code: 'VISIBLE_LIFECYCLE_ADMISSION_POLICY_INVALID' });
  }
  assert.throws(() => validateVisibleLifecycleIntent(native, { now: () => '2026-09-14T23:59:00.000Z' }), { code: 'VISIBLE_LIFECYCLE_INTENT_EXPIRED' });
  assert.throws(() => validateVisibleLifecycleIntent({ ...native, command: { ...native.command, target: 'other' } }, options), { code: 'VISIBLE_LIFECYCLE_INTENT_DIGEST_MISMATCH' });
});
