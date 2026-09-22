import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const requiredPages = [
  'README.md', 'docs/README.md', 'docs/overview/project.md', 'docs/architecture/system-design.md',
  'docs/guides/consumer-quickstart.md', 'docs/guides/flow-authoring.md', 'docs/guides/workspace-configuration.md',
  'docs/guides/project-configuration.md', 'docs/guides/control-flow.md', 'docs/guides/gates-and-decisions.md',
  'docs/guides/host-plugins.md', 'docs/guides/local-debugging.md',
  'docs/reference/configuration-api.md', 'docs/reference/protocol.md', 'docs/reference/sdk.md', 'docs/reference/commands.md', 'docs/reference/packaging.md', 'docs/operations/README.md',
  'docs/reference/legacy-compatibility.md', 'docs/history/README.md',
  'docs/flows/delivery-lifecycle/design.md', 'docs/flows/batch-production/design.md',
  'docs/flows/requirements-design/design.md', 'docs/flows/knowledge-qa/design.md',
];
const currentDirectories = new Set(['architecture', 'flows', 'guides', 'history', 'operations', 'overview', 'reference']);
const configurationSchemas = [
  'project-harness-config.schema.json', 'delivery-project-input.schema.json', 'batch-production-project-input.schema.json',
  'project-descriptor-input.schema.json', 'workflow-definition.schema.json', 'feature.schema.json',
  'composable-workflow-profile.schema.json',
];

const propertyNames = schema => {
  const names = new Set();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const name of Object.keys(value.properties ?? {})) names.add(name);
    for (const child of Object.values(value)) visit(child);
  };
  visit(schema);
  return names;
};

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
  const configurationApi = await readFile(resolve(root, 'docs/reference/configuration-api.md'), 'utf8').catch(() => '');
  const documentedFields = new Set([...configurationApi.matchAll(/`([^`\r\n]+)`/g)].map(match => match[1]).flatMap(value => value.split(/[.,]/).map(part => part.trim())));
  for (const file of configurationSchemas) {
    const schema = JSON.parse(await readFile(resolve(root, 'schemas', file), 'utf8'));
    for (const field of propertyNames(schema)) if (!documentedFields.has(field)) errors.push(`configuration API omits public field: ${file} -> ${field}`);
  }
  for (const term of ['H0', 'H1', 'H2', 'H3', 'H4', 'WORKFLOW_REPEAT_EXHAUSTED', 'deterministic-process', 'source-link']) {
    if (!configurationApi.includes(term)) errors.push(`configuration API omits required contract term: ${term}`);
  }
  for (const term of ['cardworld', 'tabletop-collection', 'contextBudgetCommand', 'maxLogicalGames', 'gameIds', 'collectionBatches']) {
    if (configurationApi.toLowerCase().includes(term.toLowerCase())) errors.push(`configuration API contains consumer-specific contract term: ${term}`);
  }
  return errors;
};
