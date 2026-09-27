import { readFile, readdir, lstat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { digestJson, sha256 } from '../common/canonical.mjs';
import { assert } from '../common/errors.mjs';
import { assertJsonSchema } from '../common/json-schema.mjs';
import { assertNoLinkPath, slash } from '../common/paths.mjs';
import { captureWorkspace } from '../common/workspace-snapshot.mjs';

const schema = JSON.parse(readFileSync(new URL('../../schemas/release-documentation-scope.schema.json', import.meta.url), 'utf8'));
const safeRelative = value => {
  assert(typeof value === 'string' && value.length > 0 && value === slash(value) && !value.startsWith('/') && !value.endsWith('/')
    && !value.includes(':') && !value.split('/').some(segment => !segment || segment === '.' || segment === '..'),
  'RELEASE_DOCUMENT_PATH_INVALID', `Release documentation path is unsafe: ${value}`);
  return value;
};

const inspectDirectory = async (root, relativePath) => {
  const directory = assertNoLinkPath(root, resolve(root, relativePath), 'release documentation directory');
  assert((await lstat(directory)).isDirectory(), 'RELEASE_DOCUMENT_DIRECTORY_INVALID', `${relativePath} is not a directory.`);
  const visit = async current => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const file = resolve(current, entry.name);
      const info = await lstat(file);
      assert(!info.isSymbolicLink(), 'RELEASE_DOCUMENT_LINK_FORBIDDEN', `Release documentation cannot contain a link: ${file}`);
      if (info.isDirectory()) await visit(file);
      else assert(info.isFile(), 'RELEASE_DOCUMENT_FILE_INVALID', `Unsupported release documentation entry: ${file}`);
    }
  };
  await visit(directory);
};

export const loadReleaseDocumentationScope = async ({ workspaceRoot, configPath, excluded = [] }) => {
  const root = resolve(workspaceRoot);
  const path = safeRelative(configPath);
  const file = assertNoLinkPath(root, resolve(root, path), 'release documentation scope');
  const bytes = await readFile(file);
  const declaration = JSON.parse(bytes.toString('utf8'));
  assertJsonSchema(declaration, schema, { code: 'RELEASE_DOCUMENT_SCOPE_INVALID', label: 'Release documentation scope' });
  const mainFiles = declaration.documents.map(item => safeRelative(item.main));
  const directories = [...new Set([...declaration.documents.map(item => item.directory).filter(Boolean), ...declaration.directories].map(safeRelative))];
  const forbidden = [...new Set(['.git', '.agent-harness-data', 'node_modules', 'target', 'dist', 'coverage', ...excluded].map(item => slash(item).replace(/\/$/, '')))];
  const isForbidden = path => forbidden.some(item => item.includes('/')
    ? path === item || path.startsWith(`${item}/`)
    : path.split('/').includes(item));
  assert([...mainFiles, ...directories].every(path => !isForbidden(path)), 'RELEASE_DOCUMENT_EXCLUDED', 'Release documentation cannot include excluded or generated paths.');
  assert(new Set(mainFiles).size === mainFiles.length, 'RELEASE_DOCUMENT_MAIN_DUPLICATE', 'Release documentation main files must be unique.');
  for (const main of mainFiles) {
    const target = assertNoLinkPath(root, resolve(root, main), 'release documentation main');
    assert((await lstat(target)).isFile(), 'RELEASE_DOCUMENT_MAIN_INVALID', `${main} is not a file.`);
  }
  for (const directory of directories) await inspectDirectory(root, directory);
  const snapshot = await captureWorkspace(root, { excluded });
  const files = snapshot.files.filter(item => mainFiles.includes(item.path) || directories.some(directory => item.path.startsWith(`${directory}/`)));
  assert(mainFiles.every(main => files.some(item => item.path === main)), 'RELEASE_DOCUMENT_EXCLUDED', 'A release documentation main file is excluded from the workspace snapshot.');
  const inventory = { schemaVersion: '1.0', configPath: path, configSha256: sha256(bytes), mainFiles, directories, files };
  return { ...inventory, inventoryDigest: digestJson(inventory), allowedPaths: [...new Set([...mainFiles, ...directories])] };
};
