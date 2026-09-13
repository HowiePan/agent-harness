import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { digestJson, sha256 } from './canonical.mjs';
import { assert } from './errors.mjs';
import { assertNoLinkPath } from './paths.mjs';
import { harnessProjectRoot } from './write-boundary.mjs';

export const verifyReleaseManifest = async ({ root: rootInput = harnessProjectRoot(), verify = true, artifactDigest = undefined } = {}) => {
  const root = resolve(rootInput);
  assertNoLinkPath(root, root, 'Harness release root');
  const manifestFile = assertNoLinkPath(root, resolve(root, 'release-manifest.json'), 'Harness release manifest');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  assert(manifest.protocolVersion === '1.0' && /^\d+\.\d+\.\d+$/.test(manifest.version ?? ''), 'HARNESS_RELEASE_MANIFEST_INVALID', 'Harness release manifest is invalid.');
  assert(Array.isArray(manifest.files) && manifest.files.length > 0, 'HARNESS_RELEASE_MANIFEST_INVALID', 'Harness release manifest requires a non-empty file list.');
  for (const file of manifest.files) assert(typeof file?.path === 'string' && !isAbsolute(file.path) && file.path !== '..' && !file.path.startsWith('../') && /^[a-f0-9]{64}$/.test(file.sha256 ?? '') && Number.isInteger(file.size) && file.size >= 0, 'HARNESS_RELEASE_MANIFEST_INVALID', 'Harness release manifest contains an invalid file record.', { file });
  assert(new Set(manifest.files.map(file => file.path)).size === manifest.files.length, 'HARNESS_RELEASE_MANIFEST_INVALID', 'Harness release manifest contains duplicate file paths.');
  assert(manifest.packageDigest === digestJson(manifest.files), 'HARNESS_RELEASE_MANIFEST_DIGEST_INVALID', 'Harness release manifest file list digest is invalid.');
  if (verify) {
    for (const file of manifest.files) {
      const bytes = await readFile(assertNoLinkPath(root, resolve(root, file.path), 'Harness release file'));
      assert(bytes.length === file.size && sha256(bytes) === file.sha256, 'HARNESS_RELEASE_FILE_MISMATCH', `Harness release file does not match its manifest: ${file.path}`, { path: file.path });
    }
  }
  if (artifactDigest !== undefined) assert(artifactDigest === manifest.packageDigest, 'HARNESS_RELEASE_OVERRIDE_MISMATCH', 'The supplied Harness digest does not match the installed release manifest.');
  return Object.freeze({ version: manifest.version, artifactDigest: manifest.packageDigest, verified: verify });
};

export const loadReleaseIdentity = options => verifyReleaseManifest(options);
