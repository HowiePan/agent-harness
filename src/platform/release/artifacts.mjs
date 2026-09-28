import { readFile, readdir, lstat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { assert } from '../../common/errors.mjs';
import { sha256 } from '../../common/canonical.mjs';
import { assertNoLinkPath, slash } from '../../common/paths.mjs';

export const safeReleaseRelativePath = (value, label) => {
  assert(typeof value === 'string' && value.length > 0 && value === slash(value) && !value.startsWith('/') && !value.endsWith('/')
    && !value.includes(':') && !value.split('/').some(segment => !segment || segment === '.' || segment === '..'),
  'RELEASE_PATH_INVALID', `${label} must be a safe project-relative path.`);
  return value;
};

export const inventoryReleaseArtifacts = async (root, relativeRoot) => {
  safeReleaseRelativePath(relativeRoot, 'release artifact root');
  const absoluteRoot = assertNoLinkPath(root, resolve(root, relativeRoot), 'release artifact root');
  assert((await lstat(absoluteRoot)).isDirectory(), 'RELEASE_ARTIFACT_ROOT_INVALID', 'Release artifact root must be a directory.');
  const files = [];
  const visit = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = resolve(directory, entry.name);
      const info = await lstat(file);
      assert(!info.isSymbolicLink(), 'RELEASE_ARTIFACT_LINK_FORBIDDEN', `Release artifact contains a link: ${file}`);
      if (info.isDirectory()) await visit(file);
      else if (info.isFile()) {
        const bytes = await readFile(file);
        files.push({ path: slash(relative(absoluteRoot, file)), sha256: sha256(bytes), size: bytes.length });
      } else assert(false, 'RELEASE_ARTIFACT_FILE_INVALID', `Unsupported release artifact entry: ${file}`);
    }
  };
  await visit(absoluteRoot);
  files.sort((a, b) => a.path.localeCompare(b.path));
  assert(files.length > 0, 'RELEASE_ARTIFACT_EMPTY', 'Release artifact package is empty.');
  return { absoluteRoot, files };
};
