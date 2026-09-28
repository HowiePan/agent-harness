import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { parsePseudoCommand } from './pseudo-command-router.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const samePath = (a, b) => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
const inside = (parent, child) => { const part = relative(parent, child); return part === '' || (!part.startsWith('..') && !isAbsolute(part)); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

const optionalFile = async path => {
  try { return await readFile(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

const repositoryRoot = async cwd => {
  let current = resolve(cwd);
  for (;;) {
    const marker = resolve(current, '.git');
    try { if (await lstat(marker)) return current; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(current);
    if (parent === current) fail('LOCAL_SOURCE_ROUTE_GIT_REQUIRED', 'Local route requires a Git checkout.');
    current = parent;
  }
};

export const configureLocalSourceRoutes = async ({ defaultBindingsDir, routes }) => {
  if (!isAbsolute(defaultBindingsDir ?? '') || !Array.isArray(routes) || !routes.length) fail('LOCAL_SOURCE_ROUTE_CONFIG_INVALID', 'Route configuration requires an absolute default bindings directory and routes.');
  const defaults = JSON.parse(await readFile(resolve(defaultBindingsDir, 'bindings.json'), 'utf8'));
  const controlRoot = await realpath(defaults?.harness?.controlRoot ?? '');
  if (!inside(controlRoot, await realpath(defaultBindingsDir))) fail('LOCAL_SOURCE_ROUTE_CONTROL_BOUNDARY', 'Default binding must be inside its Harness control root.');
  const entries = [];
  for (const route of routes) {
    const projectRoot = await realpath(route.projectRoot);
    const bindingsDir = await realpath(route.bindingsDir);
    if (!inside(controlRoot, bindingsDir)) fail('LOCAL_SOURCE_ROUTE_CONTROL_BOUNDARY', 'Route binding must be inside the bound Harness control root.');
    const bytes = await readFile(resolve(projectRoot, 'harness.json'));
    const config = JSON.parse(bytes);
    const binding = JSON.parse(await readFile(resolve(bindingsDir, 'bindings.json'), 'utf8'));
    const alias = config?.binding?.alias;
    if (!alias || alias !== route.alias || config.binding.projectId !== route.projectId || !binding.projects?.[alias] || binding.projects[alias].projectId !== route.projectId || !samePath(binding.projects[alias].workspaceRoot, projectRoot) || !samePath(binding.harness.controlRoot, controlRoot)) fail('LOCAL_SOURCE_ROUTE_IDENTITY_MISMATCH', `Route identity mismatch for ${route.alias}.`);
    entries.push({ alias, projectId: route.projectId, projectRoot, bindingsDir, configSha256: digest(bytes) });
  }
  if (new Set(entries.map(entry => `${entry.alias}|${entry.projectRoot.toLowerCase()}`)).size !== entries.length) fail('LOCAL_SOURCE_ROUTE_DUPLICATE', 'Duplicate local route.');
  return { schemaVersion: '1.0', kind: 'local-source-routes', controlRoot, entries };
};

export const selectLocalSourceBindingsDir = async ({ event, defaultBindingsDir }) => {
  if (!isAbsolute(defaultBindingsDir ?? '')) fail('LOCAL_SOURCE_ROUTE_BINDINGS_REQUIRED', 'Default bindings directory must be absolute.');
  const match = event?.prompt?.match(/^h:local\s+(.+)$/);
  if (!match) return defaultBindingsDir;
  const parsed = parsePseudoCommand(`h:${match[1]}`);
  if (!parsed || parsed.kind === 'invalid' || parsed.kind === 'init') return defaultBindingsDir;
  const root = await repositoryRoot(event.cwd ?? process.cwd());
  const cwd = await realpath(event.cwd ?? process.cwd());
  if (!inside(root, cwd)) fail('LOCAL_SOURCE_ROUTE_WORKSPACE_MISMATCH', 'Hook cwd is outside its Git checkout.');
  const indexBytes = await optionalFile(resolve(defaultBindingsDir, 'project-routes.json'));
  if (!indexBytes) return defaultBindingsDir;
  const index = JSON.parse(indexBytes);
  const defaultBinding = JSON.parse(await readFile(resolve(defaultBindingsDir, 'bindings.json'), 'utf8'));
  if (index.schemaVersion !== '1.0' || index.kind !== 'local-source-routes' || !samePath(index.controlRoot, defaultBinding.harness.controlRoot) || !Array.isArray(index.entries)) fail('LOCAL_SOURCE_ROUTE_INDEX_INVALID', 'Local route index is invalid.');
  let current = cwd;
  for (;;) {
    const configBytes = await optionalFile(resolve(current, 'harness.json'));
    if (configBytes) {
      let config;
      try { config = JSON.parse(configBytes); }
      catch { fail('LOCAL_SOURCE_ROUTE_CONFIG_INVALID', `Invalid harness.json at ${current}.`); }
      const alias = config?.binding?.alias;
      if (!alias || typeof alias !== 'string') fail('LOCAL_SOURCE_ROUTE_CONFIG_INVALID', `Missing project alias at ${current}.`);
      if (!parsed.projectAlias || parsed.projectAlias === alias) {
        const entries = index.entries.filter(entry => entry.alias === alias && samePath(entry.projectRoot, current));
        if (entries.length !== 1) fail('LOCAL_SOURCE_ROUTE_NOT_REGISTERED', `Project route is not uniquely registered for ${alias} at ${current}.`);
        const selected = entries[0];
        if (selected.projectId !== config.binding.projectId || selected.configSha256 !== digest(configBytes) || !isAbsolute(selected.bindingsDir) || !inside(await realpath(index.controlRoot), await realpath(selected.bindingsDir))) fail('LOCAL_SOURCE_ROUTE_IDENTITY_MISMATCH', `Registered route is stale or invalid for ${alias}.`);
        const binding = JSON.parse(await readFile(resolve(selected.bindingsDir, 'bindings.json'), 'utf8'));
        if (!binding.projects?.[alias] || binding.projects[alias].projectId !== selected.projectId || !samePath(binding.projects[alias].workspaceRoot, current) || !samePath(binding.harness.controlRoot, index.controlRoot)) fail('LOCAL_SOURCE_ROUTE_IDENTITY_MISMATCH', `Binding identity mismatch for ${alias}.`);
        return selected.bindingsDir;
      }
    }
    if (samePath(current, root)) break;
    current = dirname(current);
  }
  fail('LOCAL_SOURCE_ROUTE_ALIAS_UNKNOWN', `No registered ancestor project matches ${parsed.projectAlias ?? 'the current directory'}.`);
};
