import { lstat, readFile, readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { digestJson, sha256 } from '../canonical.mjs';
import { slash } from '../paths.mjs';

export const inventoryTree = async rootInput => {
  const root = resolve(rootInput);
  const files = [];
  const visit = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const file = resolve(directory, entry.name);
      const info = await lstat(file);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) await visit(file);
      else if (info.isFile()) {
        const bytes = await readFile(file);
        files.push({ path: slash(relative(root, file)), sha256: sha256(bytes), size: bytes.length });
      }
    }
  };
  await visit(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { root, files, sourceDigest: digestJson(files) };
};

export const readJsonIfValid = async file => {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
};
