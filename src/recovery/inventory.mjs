import { lstat, readFile, readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { digestJson, sha256 } from '../canonical.mjs';
import { assert } from '../errors.mjs';
import { slash } from '../paths.mjs';

export const inventoryTree = async rootInput => {
  const root = resolve(rootInput);
  const rootInfo = await lstat(root);
  assert(!rootInfo.isSymbolicLink(), 'RECOVERY_LINK_FORBIDDEN', 'Legacy inventory root cannot be a symbolic link or Windows junction.', { path: root });
  assert(rootInfo.isDirectory(), 'LEGACY_INVENTORY_ROOT_INVALID', 'Legacy inventory root must be a directory.', { path: root });
  const files = [];
  const visit = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = resolve(directory, entry.name);
      const info = await lstat(file);
      assert(!info.isSymbolicLink(), 'RECOVERY_LINK_FORBIDDEN', 'Legacy inventory cannot contain symbolic links or Windows junctions.', { path: slash(relative(root, file)) });
      if (info.isDirectory()) await visit(file);
      else if (info.isFile()) {
        const bytes = await readFile(file);
        files.push({ path: slash(relative(root, file)), sha256: sha256(bytes), size: bytes.length });
      } else assert(false, 'LEGACY_INVENTORY_NODE_REJECTED', 'Legacy inventory contains an unsupported filesystem node.', { path: slash(relative(root, file)) });
    }
  };
  await visit(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { root, files, sourceDigest: digestJson(files) };
};

export const readJsonIfValid = async file => {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
};
