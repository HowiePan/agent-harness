import assert from 'node:assert/strict';
import test from 'node:test';
import { sealReleaseCandidateReceipt, verifyReleaseCandidateReceipt } from '../src/index.mjs';

const digest = 'a'.repeat(64);
const receipt = {
  protocolVersion: '1.0',
  kind: 'release-candidate-receipt',
  version: '1.0.0',
  source: { commit: 'b'.repeat(40), clean: true },
  releaseManifest: { packageDigest: digest, sha256: digest, fileCount: 1 },
  sbom: { sha256: digest, spdxVersion: 'SPDX-2.3' },
  archive: { fileName: 'agent-harness-1.0.0.tgz', sha256: digest, size: 1, npmIntegrity: 'sha512-example', npmShasum: 'c'.repeat(40) },
  probes: { manifestVerified: true, sbomVerified: true, packageInstalled: true, codexPluginVerified: true, skillEntrypointsVerified: true, relativeReferencesVerified: true, pathBoundaryVerified: true },
  createdAt: '2026-09-13T00:00:00.000Z',
};

test('release candidate Receipt is schema-checked and digest-bound', () => {
  const sealed = sealReleaseCandidateReceipt(receipt);
  assert.match(sealed.receiptDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(verifyReleaseCandidateReceipt(sealed), sealed);
  assert.throws(() => verifyReleaseCandidateReceipt({ ...sealed, archive: { ...sealed.archive, size: 2 } }), error => error.code === 'RELEASE_RECEIPT_DIGEST_MISMATCH');
});

test('release candidate Receipt cannot claim a dirty source or incomplete probe', () => {
  assert.throws(() => sealReleaseCandidateReceipt({ ...receipt, source: { ...receipt.source, clean: false } }), error => error.code === 'RELEASE_RECEIPT_SCHEMA_INVALID');
  assert.throws(() => sealReleaseCandidateReceipt({ ...receipt, probes: { ...receipt.probes, packageInstalled: false } }), error => error.code === 'RELEASE_RECEIPT_SCHEMA_INVALID');
});
