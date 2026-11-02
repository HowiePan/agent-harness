import { lstat, readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digestJson, sha256 } from '../common/canonical.mjs';
import { assert } from '../common/errors.mjs';
import { assertNoLinkPath } from '../common/paths.mjs';

// Validate the complete tree before reading artifact bytes. A late cache link
// must not require hashing gigabytes of unrelated earlier files to discover it.
export const inspectDeliveryPaths = async (root, paths, onProgress = () => {}) => {
  const entries = [];
  let nextProgress = 0;
  const report = phase => {
    if (phase !== 'path-inspection-progress' || Date.now() >= nextProgress) {
      onProgress({ phase, entries: entries.length }); nextProgress = Date.now() + 1000;
    }
  };
  const visit = async path => {
    const absolute = assertNoLinkPath(root, resolve(root, path), 'delivery verification input');
    let stat;
    try { stat = await lstat(absolute); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      entries.push({ path, kind: 'missing' }); report('path-inspection-progress'); return;
    }
    assert(!stat.isSymbolicLink(), 'DELIVERY_VERIFICATION_LINK', 'Linked proof inputs are not reusable.');
    entries.push({ path, kind: stat.isDirectory() ? 'directory' : 'file' });
    report('path-inspection-progress');
    if (stat.isDirectory()) for (const name of (await readdir(absolute)).sort()) await visit(`${path}/${name}`);
  };
  report('path-inspection-started');
  for (const path of [...new Set(paths)].sort()) await visit(path);
  report('path-inspection-finished');
  return entries;
};

export const fingerprintDeliveryPaths = async (root, paths, onProgress = () => {}) => {
  const inventory = await inspectDeliveryPaths(root, paths, onProgress);
  const entries = [];
  let nextProgress = 0;
  onProgress({ phase: 'fingerprint-started', entries: inventory.length });
  for (const entry of inventory) {
    const absolute = assertNoLinkPath(root, resolve(root, entry.path), 'delivery verification input');
    entries.push([entry.path, entry.kind === 'missing' ? null : entry.kind === 'directory' ? 'directory' : sha256(await readFile(absolute))]);
    if (Date.now() >= nextProgress) {
      onProgress({ phase: 'fingerprint-progress', entries: entries.length, total: inventory.length }); nextProgress = Date.now() + 1000;
    }
  }
  onProgress({ phase: 'fingerprint-finished', entries: entries.length });
  return digestJson(entries);
};
