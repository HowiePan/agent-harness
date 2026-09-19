import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const requiredPages = [
  'README.md', 'docs/README.md', 'docs/overview/project.md', 'docs/architecture/system-design.md',
  'docs/guides/consumer-quickstart.md', 'docs/guides/flow-authoring.md', 'docs/guides/workspace-configuration.md',
  'docs/reference/protocol.md', 'docs/reference/sdk.md', 'docs/reference/commands.md', 'docs/operations/README.md',
  'docs/reference/legacy-compatibility.md', 'docs/history/README.md',
  'docs/flows/delivery-lifecycle/design.md', 'docs/flows/batch-production/design.md',
  'docs/flows/requirements-design/design.md', 'docs/flows/knowledge-qa/design.md',
];
const currentDirectories = new Set(['architecture', 'flows', 'guides', 'history', 'operations', 'overview', 'reference']);

const markdownPages = async (directory, root) => {
  const pages = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) pages.push(...await markdownPages(file, root));
    else if (entry.isFile() && entry.name.endsWith('.md')) pages.push(file.slice(root.length + 1).replaceAll('\\', '/'));
  }
  return pages;
};

export const checkCurrentDocs = async root => {
  const errors = [];
  for (const page of requiredPages) {
    try { await access(resolve(root, page)); }
    catch { errors.push(`missing required document: ${page}`); }
  }
  for (const entry of await readdir(resolve(root, 'docs'), { withFileTypes: true })) {
    if (entry.isDirectory() && !currentDirectories.has(entry.name)) errors.push(`unexpected top-level docs directory: ${entry.name}`);
    if (entry.isFile() && entry.name !== 'README.md') errors.push(`unexpected top-level docs file: ${entry.name}`);
  }
  for (const page of await markdownPages(resolve(root, 'docs'), root)) {
    const file = resolve(root, page);
    const source = await readFile(file, 'utf8');
    if (page === 'docs/overview/project.md' && /\]\(/.test(source)) errors.push('external overview must be self-contained and contain no document links');
    for (const match of source.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1].split('#', 1)[0];
      if (!target || /^(?:[a-z]+:|\/)/i.test(target)) continue;
      try { await access(resolve(dirname(file), target)); }
      catch { errors.push(`broken current document link: ${page} -> ${target}`); }
    }
  }
  return errors;
};
