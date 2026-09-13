import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digestJson } from '../canonical.mjs';
import { assert } from '../errors.mjs';
import { validatePluginManifest } from './contracts.mjs';

export const loadPlugin = async ({ host, module: moduleSpecifier, config = {}, context = {} }) => {
  assert(moduleSpecifier, 'PLUGIN_MODULE_REQUIRED', 'Plugin module is required.');
  const specifier = isAbsolute(moduleSpecifier) || moduleSpecifier.startsWith('.') ? pathToFileURL(resolve(moduleSpecifier)).href : moduleSpecifier;
  const loaded = await import(specifier);
  const manifest = loaded.manifest ?? loaded.default?.manifest;
  const factory = loaded.createPlugin ?? loaded.default?.createPlugin;
  assert(manifest && typeof factory === 'function', 'PLUGIN_MODULE_CONTRACT_INVALID', 'Plugin module must export manifest and createPlugin().');
  const instance = await factory(structuredClone(config), context);
  return host.register(manifest, instance);
};

const contractIdentity = manifest => ({
  id: manifest.id,
  kind: manifest.kind,
  version: manifest.version,
  capabilities: manifest.capabilities,
  permissions: manifest.permissions,
  execution: manifest.execution ?? null,
});

export const loadPluginFromManifest = async ({ host, manifestPath, config = {}, context = {} }) => {
  const file = resolve(manifestPath);
  const declared = validatePluginManifest(JSON.parse(await readFile(file, 'utf8')));
  assert(declared.entry, 'PLUGIN_ENTRY_REQUIRED', `Plugin manifest has no entry: ${file}`);
  const loaded = await loadPlugin({ host, module: resolve(dirname(file), declared.entry), config, context });
  assert(digestJson(contractIdentity(loaded)) === digestJson(contractIdentity(declared)), 'PLUGIN_ENTRY_MANIFEST_MISMATCH', `Plugin entry does not match its manifest: ${file}`);
  return loaded;
};
