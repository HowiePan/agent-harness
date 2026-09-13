import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createDefectBundle, verifyDefectBundle } from '../src/index.mjs';

const digest = 'a'.repeat(64);
const input = {
  protocolVersion: '1.0',
  harness: { version: '1.0.0', artifactDigest: digest, commit: 'abc123' },
  extensions: [{ id: 'neutral-profile', version: '1.0.0' }],
  descriptorDigest: digest,
  command: { operation: 'run.start' },
  authorityRevision: 2,
  dispatchIds: ['dispatch-1'],
  evidenceRefs: [],
  expected: { status: 'completed' },
  actual: { status: 'blocked' },
  reproduction: { fixture: 'synthetic' },
  sanitization: { confirmed: true, removed: ['workspace path'] },
};

test('Defect Bundle is digest-bound and requires explicit sanitization', () => {
  const bundle = createDefectBundle(input);
  assert.match(bundle.bundleDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(verifyDefectBundle(bundle), bundle);
  assert.throws(() => createDefectBundle({ ...input, sanitization: { confirmed: false } }), error => error.code === 'DEFECT_SANITIZATION_REQUIRED');
});

test('Defect Bundle rejects common secret and prompt fields', () => {
  assert.throws(() => createDefectBundle({ ...input, reproduction: { fixture: 'synthetic', accessToken: 'redacted' } }), error => error.code === 'DEFECT_SENSITIVE_FIELD_REJECTED');
});

test('PUB-008 sanitized consumer defect fixture remains independently reproducible', async () => {
  const bundle = JSON.parse(await readFile(new URL('../docs/acceptance/evidence/pub-008-cardworld-recovery-defect.json', import.meta.url), 'utf8'));
  assert.deepEqual(verifyDefectBundle(bundle), bundle);
  assert.equal(bundle.reproduction.fixture, 'synthetic-changing-source');
  assert.equal(bundle.sanitization.removed.includes('credentials'), true);
});
