import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { digestJson, sha256 } from '../../canonical.mjs';
import { assert } from '../../errors.mjs';
import { assertInside } from '../../paths.mjs';
import { envelope } from '../contracts.mjs';

export const createLocalArtifactProvider = ({ manifest, allowedRoot }) => ({
  async resolve(request) {
    const manifestFile = assertInside(allowedRoot, resolve(allowedRoot, request.manifestPath), 'artifact manifest');
    const value = JSON.parse(await readFile(manifestFile, 'utf8'));
    const base = dirname(manifestFile);
    const artifacts = [];
    for (const item of value.artifacts ?? []) {
      const file = assertInside(allowedRoot, resolve(base, item.path), 'artifact');
      const bytes = await readFile(file);
      const digest = sha256(bytes);
      assert(!item.sha256 || item.sha256.toLowerCase() === digest, 'ARTIFACT_DIGEST_MISMATCH', `Artifact digest mismatch: ${item.path}`);
      artifacts.push({ path: item.path, sha256: digest, size: bytes.length });
    }
    const identity = { manifestPath: request.manifestPath, manifestDigest: digestJson(value), version: value.version ?? null, apiVersion: value.apiVersion ?? null, abiVersion: value.abiVersion ?? null, artifacts };
    return envelope(manifest, 'receipt', { operation: 'artifact-resolve', identity, identityDigest: digestJson(identity) });
  },
});
