import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { digestJson, sha256 } from '../../common/canonical.mjs';
import { assert } from '../../common/errors.mjs';
import { assertNoLinkPath } from '../../common/paths.mjs';
import { captureWorkspace } from '../../common/workspace-snapshot.mjs';

const validSourceId = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const inside = (root, path) => { const child = relative(root, path); return child === '' || (!child.startsWith('..') && !isAbsolute(child)); };

/** Capture every permitted input as an independent, read-only revision. */
export const captureSourceManifest = async ({ projectId, sources, workspaceRef = null, projectIds = null }) => {
  assert(projectId && Array.isArray(sources) && sources.length > 0, 'SOURCE_MANIFEST_REQUIRED', 'Source Manifest requires a Project and sources.');
  const seen = new Set();
  const entries = [];
  for (const source of sources) {
    assert(validSourceId.test(source?.sourceId ?? '') && !seen.has(source.sourceId), 'SOURCE_ID_INVALID', 'Source IDs must be unique and safe.');
    seen.add(source.sourceId);
    assert(['document', 'repository'].includes(source.type) && isAbsolute(source.root ?? ''), 'SOURCE_DECLARATION_INVALID', 'Source requires a document or repository type and an absolute root.');
    const root = resolve(source.root);
    const snapshot = await captureWorkspace(root, { excluded: source.excluded ?? [] });
    const allowedPaths = source.allowedPaths ?? snapshot.files.map(file => file.path);
    assert(Array.isArray(allowedPaths) && allowedPaths.length > 0 && allowedPaths.every(path => typeof path === 'string' && path && !path.startsWith('/') && !path.includes('..') && !path.includes('\\')), 'SOURCE_SCOPE_INVALID', 'Source allowedPaths must be safe relative paths.');
    const files = snapshot.files.filter(file => allowedPaths.some(path => file.path === path || file.path.startsWith(`${path}/`)));
    assert(files.length > 0, 'SOURCE_SCOPE_EMPTY', `Source ${source.sourceId} contains no permitted files.`);
    const revision = source.revision ?? digestJson(files);
    const contentDigest = digestJson(files);
    const accessScope = [...new Set(source.allowedReceivers ?? [])].sort();
    entries.push({ sourceId: source.sourceId, type: source.type, root, revision, contentDigest, accessScope, files });
  }
  entries.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  const body = { schemaVersion: '1.0', projectId, ...(workspaceRef ? { workspaceRef: structuredClone(workspaceRef) } : {}), ...(projectIds ? { projectIds: [...projectIds].sort() } : {}), ...(workspaceRef ? { sourceSetDigest: digestJson(entries.map(source => ({ sourceId: source.sourceId, root: source.root, revision: source.revision, contentDigest: source.contentDigest }))) } : {}), sources: entries };
  return { ...body, manifestDigest: digestJson(body) };
};

export const verifySourceManifest = manifest => {
  const { manifestDigest, ...body } = manifest;
  assert(manifestDigest === digestJson(body), 'SOURCE_MANIFEST_DIGEST_MISMATCH', 'Source Manifest digest changed.');
  return manifest;
};

export const assertSourceManifestCurrent = async manifestInput => {
  const manifest = verifySourceManifest(manifestInput);
  for (const source of manifest.sources) for (const entry of source.files) {
    const absolute = resolve(source.root, entry.path);
    assert(inside(source.root, absolute), 'SOURCE_PATH_DENIED', 'Source path escapes its root.');
    assertNoLinkPath(source.root, absolute, 'Source path');
    assert(sha256(await readFile(absolute)) === entry.sha256, 'SOURCE_DRIFT', `Pinned source changed: ${source.sourceId}/${entry.path}`);
  }
  return manifest;
};

/** Read exactly the pinned bytes, subject to a receiver allowlist. */
export const readPinnedSource = async (manifestInput, { sourceId, path, receiverId }) => {
  const manifest = verifySourceManifest(manifestInput);
  const source = manifest.sources.find(item => item.sourceId === sourceId);
  assert(source, 'SOURCE_NOT_FOUND', `Source ${sourceId} is not in the Manifest.`);
  assert(source.accessScope.includes(receiverId), 'SOURCE_RECEIVER_DENIED', `Receiver ${receiverId} cannot read ${sourceId}.`);
  const entry = source.files.find(file => file.path === path);
  assert(entry, 'SOURCE_PATH_DENIED', `Path ${path} is outside the pinned source scope.`);
  const absolute = resolve(source.root, entry.path);
  assert(inside(source.root, absolute), 'SOURCE_PATH_DENIED', 'Source path escapes its root.');
  assertNoLinkPath(source.root, absolute, 'Source path');
  const bytes = await readFile(absolute);
  assert(sha256(bytes) === entry.sha256, 'SOURCE_DRIFT', `Pinned source changed: ${sourceId}/${path}`);
  return { bytes, sourceId, path, contentDigest: entry.sha256, revision: source.revision, manifestDigest: manifest.manifestDigest };
};
