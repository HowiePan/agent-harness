import { lstat, readFile, readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { digestJson, sha256 } from './canonical.mjs';
import { slash } from './paths.mjs';

const defaultExcluded = new Set(['.git', 'node_modules', 'target', 'dist', 'coverage', '.agent-harness-data']);

export const captureWorkspace = async (rootInput, { excluded = [] } = {}) => {
  const root = resolve(rootInput);
  const excludedNames = new Set([...defaultExcluded, ...excluded]);
  const files = [];
  const visit = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (excludedNames.has(entry.name) || entry.name.endsWith('.tmp') || entry.name.endsWith('.log')) continue;
      const absolute = resolve(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) await visit(absolute);
      else if (info.isFile()) {
        const bytes = await readFile(absolute);
        files.push({ path: slash(relative(root, absolute)), sha256: sha256(bytes), size: bytes.length });
      }
    }
  };
  await visit(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { protocolVersion: '1.0', root, files, digest: digestJson(files) };
};

export const diffWorkspaceSnapshots = (before, after) => {
  const left = new Map((before?.files ?? []).map(file => [file.path, `${file.sha256}:${file.size}`]));
  const right = new Map((after?.files ?? []).map(file => [file.path, `${file.sha256}:${file.size}`]));
  return [...new Set([...left.keys(), ...right.keys()])]
    .filter(path => left.get(path) !== right.get(path))
    .sort();
};
