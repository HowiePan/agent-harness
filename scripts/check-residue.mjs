import { readdir, rmdir } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const forbiddenExtensions = new Set(['.exe', '.pdb']);

const walk = async directory => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.agent-harness-data') continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (forbiddenExtensions.has(extname(entry.name).toLowerCase())) errors.push(path.slice(root.length + 1));
  }
};

const pruneEmptyTree = async directory => {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  for (const entry of entries) if (entry.isDirectory()) await pruneEmptyTree(resolve(directory, entry.name));
  try { await rmdir(directory); return true; }
  catch (error) { if (error.code === 'ENOENT') return true; if (error.code === 'ENOTEMPTY') return false; throw error; }
};

await walk(root);
for (const path of [resolve(root, '.tmp'), resolve(root, '.agent-harness-cache', 'npm'), resolve(root, '.agent-harness-cache')]) {
  if (!await pruneEmptyTree(path)) errors.push(`non-empty transient directory: ${path.slice(root.length + 1)}`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else console.log(JSON.stringify({ ok: true, forbiddenExtensions: [...forbiddenExtensions], transientDirectories: 'absent' }, null, 2));
