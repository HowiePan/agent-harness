import { mkdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { canonicalize, digestJson, sha256, withoutKeys } from '../canonical.mjs';
import { assert } from '../errors.mjs';
import { atomicWrite, atomicWriteJson, readJson } from './atomic-io.mjs';
import { assertHarnessWritePath } from '../write-boundary.mjs';

const toBytes = value => Buffer.isBuffer(value) ? value : typeof value === 'string' ? Buffer.from(value) : Buffer.from(canonicalize(value));

export class EvidenceStore {
  constructor({ root, controlRoot, now = () => new Date().toISOString() }) {
    this.root = assertHarnessWritePath(root, 'Evidence root', controlRoot);
    this.now = now;
  }

  async put(value, metadata) {
    const bytes = toBytes(value);
    const digest = sha256(bytes);
    const directory = resolve(this.root, 'evidence', 'sha256', digest.slice(0, 2));
    await mkdir(directory, { recursive: true });
    const blob = resolve(directory, digest);
    try { await stat(blob); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await atomicWrite(blob, bytes, { root: this.root });
    }
    const record = {
      protocolVersion: '1.0',
      sha256: digest,
      size: bytes.length,
      mediaType: metadata.mediaType ?? 'application/octet-stream',
      createdAt: metadata.createdAt ?? this.now(),
      projectId: metadata.projectId,
      ...(metadata.workspaceRef ? { workspaceRef: structuredClone(metadata.workspaceRef) } : {}),
      runId: metadata.runId,
      epoch: metadata.epoch,
      generation: metadata.generation,
      featureId: metadata.featureId ?? null,
      dispatchId: metadata.dispatchId ?? null,
      sourceDigest: metadata.sourceDigest ?? null,
      artifactDigest: metadata.artifactDigest ?? null,
      policyDigest: metadata.policyDigest ?? null,
      pluginSetDigest: metadata.pluginSetDigest ?? null,
      toolchainDigest: metadata.toolchainDigest ?? null,
      gateSpecDigest: metadata.gateSpecDigest ?? null,
      retention: metadata.retention ?? 'run',
      labels: [...new Set(metadata.labels ?? [])].sort(),
    };
    assert(record.projectId && record.runId && Number.isInteger(record.epoch) && Number.isInteger(record.generation), 'EVIDENCE_CONTEXT_REQUIRED', 'Evidence must bind project, run, epoch, and generation.');
    const metadataDigest = digestJson(record);
    const complete = { ...record, ref: `evidence:${digest}:${metadataDigest}`, metadataDigest };
    await atomicWriteJson(`${blob}.${metadataDigest}.json`, complete, { root: this.root });
    return complete;
  }

  async read(ref) {
    const match = /^evidence:([a-f0-9]{64}):([a-f0-9]{64})$/.exec(String(ref));
    assert(match, 'EVIDENCE_REF_INVALID', 'Evidence reference must bind content and metadata SHA-256 digests.', { ref });
    const [, digest, metadataDigest] = match;
    const blob = resolve(this.root, 'evidence', 'sha256', digest.slice(0, 2), digest);
    const bytes = await readFile(blob);
    assert(sha256(bytes) === digest, 'EVIDENCE_DIGEST_MISMATCH', 'Evidence content digest does not match its reference.', { ref });
    const metadata = await readJson(`${blob}.${metadataDigest}.json`);
    assert(metadata.ref === ref && metadata.metadataDigest === metadataDigest && metadataDigest === digestJson(withoutKeys(metadata, ['ref', 'metadataDigest'])), 'EVIDENCE_METADATA_INVALID', 'Evidence metadata digest does not match.');
    return { bytes, metadata };
  }
}
