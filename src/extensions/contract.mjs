import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { digestJson, sha256 } from '../canonical.mjs';
import { assert } from '../errors.mjs';
import { assertInside, assertNoLinkPath } from '../paths.mjs';
import { defineCommandManifest } from './command-contract.mjs';
import { EXTENSION_OPERATION_CLASSES } from '../execution-boundary.mjs';

const semanticVersion = /^\d+\.\d+\.\d+$/;
const verifiedArtifactPacks = new WeakSet();

export const defineExtensionPack = input => {
  assert(input?.id && /^[a-z0-9][a-z0-9.-]+$/.test(input.id), 'EXTENSION_ID_INVALID', 'Extension Pack requires a stable lowercase ID.');
  assert(semanticVersion.test(input.version ?? ''), 'EXTENSION_VERSION_INVALID', `Extension Pack ${input.id} requires a semantic version.`);
  const operations = { ...(input.operations ?? {}) };
  const operationManifest = Object.fromEntries(Object.entries(input.operationManifest ?? {}).map(([name, declaration]) => [name, Object.freeze(structuredClone(declaration))]));
  const operationNames = Object.keys(operations).sort();
  const declaredOperationNames = Object.keys(operationManifest).sort();
  assert(operationNames.length === declaredOperationNames.length && operationNames.every((name, index) => name === declaredOperationNames[index]), 'EXTENSION_OPERATION_MANIFEST_MISMATCH', `Extension Pack ${input.id} operationManifest must declare exactly every operation.`, { operations: operationNames, declaredOperations: declaredOperationNames });
  for (const [name, declaration] of Object.entries(operationManifest)) {
    assert(/^[a-z][A-Za-z0-9]{0,63}$/.test(name), 'EXTENSION_OPERATION_ID_INVALID', `Extension Pack ${input.id} contains an invalid operation ID: ${name}`);
    assert(declaration?.executionClass === EXTENSION_OPERATION_CLASSES.PURE_PLANNER, 'EXTENSION_OPERATION_CLASS_INVALID', `Extension Pack ${input.id} operation ${name} must be a pure planner.`, { actual: declaration?.executionClass ?? null });
  }
  const pack = {
    id: input.id,
    version: input.version,
    ...(input.digest ? { digest: input.digest } : {}),
    profiles: Object.freeze([...(input.profiles ?? [])]),
    plugins: Object.freeze([...(input.plugins ?? [])]),
    recoveryImporters: Object.freeze([...(input.recoveryImporters ?? [])]),
    operations: Object.freeze(operations),
    operationManifest: Object.freeze(operationManifest),
    ...(input.commandManifest ? { commandManifest: defineCommandManifest(input.commandManifest) } : {}),
  };
  assert(!pack.digest || /^[a-f0-9]{64}$/.test(pack.digest), 'EXTENSION_DIGEST_INVALID', `Extension Pack ${pack.id} digest must be SHA-256.`);
  for (const plugin of pack.plugins) {
    assert(plugin?.manifest && typeof plugin.create === 'function', 'EXTENSION_PLUGIN_INVALID', `Extension Pack ${pack.id} contains an invalid plugin registration.`);
  }
  for (const operation of Object.values(pack.operations)) assert(typeof operation === 'function', 'EXTENSION_OPERATION_INVALID', `Extension Pack ${pack.id} operations must be functions.`);
  return Object.freeze(pack);
};

export const extensionIdentity = pack => ({ id: pack.id, version: pack.version, ...(pack.digest ? { digest: pack.digest } : {}) });

export const installExtensionPacks = async (packs, { profileRegistry, pluginHost, factoryContext = {}, requireVerifiedArtifacts = false }) => {
  const installed = [];
  const importers = [];
  const ids = new Set();
  for (const input of packs ?? []) {
    if (requireVerifiedArtifacts) assert(verifiedArtifactPacks.has(input), 'EXTENSION_ARTIFACT_VERIFICATION_REQUIRED', `Production Extension ${input?.id ?? '<unknown>'} must be loaded from a verified complete artifact manifest.`);
    const pack = defineExtensionPack(input);
    assert(!ids.has(pack.id), 'EXTENSION_DUPLICATE', `Extension Pack already installed: ${pack.id}`);
    ids.add(pack.id);
    for (const profile of pack.profiles) profileRegistry.register(profile);
    const { resolveAgentAdapter, ...sharedContext } = factoryContext;
    for (const plugin of pack.plugins) {
      const agentAdapter = typeof resolveAgentAdapter === 'function' ? resolveAgentAdapter(plugin.manifest.id) : sharedContext.agentAdapter;
      pluginHost.register(plugin.manifest, await plugin.create(Object.freeze({ ...sharedContext, agentAdapter })));
    }
    importers.push(...pack.recoveryImporters);
    installed.push(extensionIdentity(pack));
  }
  installed.sort((a, b) => a.id.localeCompare(b.id));
  return { installed, digest: digestJson(installed), recoveryImporters: importers };
};

const importPattern = /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"](\.[^'"]+)['"]/g;

export const resolveExtensionModule = (moduleSpecifier, { cwd = process.cwd() } = {}) => {
  assert(moduleSpecifier, 'EXTENSION_MODULE_REQUIRED', 'Extension module is required.');
  if (moduleSpecifier.startsWith('file:')) return fileURLToPath(moduleSpecifier);
  if (isAbsolute(moduleSpecifier) || moduleSpecifier.startsWith('.')) return resolve(cwd, moduleSpecifier);
  try { return fileURLToPath(import.meta.resolve(moduleSpecifier)); }
  catch { return createRequire(resolve(cwd, 'package.json')).resolve(moduleSpecifier); }
};

export const digestExtensionModuleGraph = async (entryPath, { controlRoot } = {}) => {
  const root = controlRoot ? resolve(controlRoot) : dirname(entryPath);
  const pending = [resolve(entryPath)];
  const visited = new Set();
  const files = [];
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    if (controlRoot) assertNoLinkPath(root, file, 'Extension module');
    visited.add(file);
    const bytes = await readFile(file);
    files.push({ path: relative(root, file).replaceAll('\\', '/'), sha256: sha256(bytes), size: bytes.length });
    const source = bytes.toString('utf8');
    for (const match of source.matchAll(importPattern)) {
      let dependency = resolve(dirname(file), match[1]);
      if (!/\.[A-Za-z0-9]+$/.test(dependency)) dependency += '.mjs';
      pending.push(dependency);
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return digestJson(files);
};

const readOptionalJson = async file => {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

const findArtifactManifest = async (entryPath, controlRoot) => {
  const boundary = resolve(controlRoot ?? dirname(entryPath));
  let current = dirname(resolve(entryPath));
  while (true) {
    if (controlRoot) assertInside(boundary, current, 'Extension artifact directory');
    for (const name of ['agent-harness-extension.json', 'release-manifest.json']) {
      const file = resolve(current, name);
      const manifest = await readOptionalJson(file);
      if (manifest) return { file, root: current, kind: name === 'release-manifest.json' ? 'release' : 'extension', manifest };
    }
    if (current === boundary || dirname(current) === current) return null;
    const parent = dirname(current);
    if (controlRoot && relative(boundary, parent).startsWith('..')) return null;
    current = parent;
  }
};

const verifyArtifactManifest = async (artifact, entryPath, controlRoot) => {
  const { manifest, root, kind, file } = artifact;
  const expectedDigest = kind === 'release' ? manifest.packageDigest : manifest.artifactDigest;
  assert(manifest.protocolVersion === '1.0' && Array.isArray(manifest.files) && /^[a-f0-9]{64}$/.test(expectedDigest ?? ''), 'EXTENSION_ARTIFACT_MANIFEST_INVALID', 'Extension artifact manifest is invalid.', { file });
  assert(digestJson(manifest.files) === expectedDigest, 'EXTENSION_ARTIFACT_MANIFEST_DIGEST_MISMATCH', 'Extension artifact manifest digest is invalid.', { file });
  const entryRelative = relative(root, entryPath).replaceAll('\\', '/');
  if (kind === 'extension') assert(manifest.entry === entryRelative, 'EXTENSION_ARTIFACT_ENTRY_MISMATCH', 'Extension artifact manifest entry does not match the loaded entrypoint.', { file, expectedEntry: manifest.entry, actualEntry: entryRelative });
  assert(manifest.files.some(item => item.path === entryRelative), 'EXTENSION_ENTRY_NOT_IN_ARTIFACT', 'Extension entrypoint is not covered by its artifact manifest.', { file, entryRelative });
  for (const item of manifest.files) {
    assert(typeof item?.path === 'string' && !isAbsolute(item.path) && item.path !== '..' && !item.path.startsWith('../') && /^[a-f0-9]{64}$/.test(item.sha256 ?? '') && Number.isInteger(item.size) && item.size >= 0, 'EXTENSION_ARTIFACT_FILE_INVALID', 'Extension artifact manifest contains an invalid file record.', { file, item });
    const artifactFile = assertInside(root, resolve(root, item.path), 'Extension artifact file');
    if (controlRoot) assertNoLinkPath(controlRoot, artifactFile, 'Extension artifact file');
    const bytes = await readFile(artifactFile);
    assert(bytes.length === item.size && sha256(bytes) === item.sha256, 'EXTENSION_ARTIFACT_DIGEST_MISMATCH', 'Extension artifact does not match its installation receipt.', { file: artifactFile, expectedSha256: item.sha256, actualSha256: sha256(bytes) });
  }
  return { digest: expectedDigest, manifest };
};

export const inspectExtensionArtifact = async (moduleSpecifier, { cwd = process.cwd(), controlRoot, expectedDigest, requireArtifactManifest = false } = {}) => {
  const resolvedPath = resolveExtensionModule(moduleSpecifier, { cwd });
  if (controlRoot) assertNoLinkPath(controlRoot, resolvedPath, 'Extension entrypoint');
  const artifact = requireArtifactManifest ? await findArtifactManifest(resolvedPath, controlRoot) : null;
  assert(!requireArtifactManifest || artifact, 'EXTENSION_ARTIFACT_MANIFEST_REQUIRED', 'Installed Extensions require a complete artifact manifest. Bundle every runtime dependency inside the artifact root.', { resolvedPath });
  const verified = artifact ? await verifyArtifactManifest(artifact, resolvedPath, controlRoot) : null;
  const digest = verified?.digest ?? await digestExtensionModuleGraph(resolvedPath, { controlRoot });
  if (expectedDigest) assert(digest === expectedDigest, 'EXTENSION_ARTIFACT_DIGEST_MISMATCH', 'Extension artifact does not match its installation receipt.', { expectedDigest, actualDigest: digest, resolvedPath });
  return Object.freeze({ resolvedPath, digest, manifest: verified?.manifest ?? null });
};

export const loadExtensionPack = async (moduleSpecifier, { cwd = process.cwd(), controlRoot, expectedDigest, requireArtifactManifest = false } = {}) => {
  const inspected = await inspectExtensionArtifact(moduleSpecifier, { cwd, controlRoot, expectedDigest, requireArtifactManifest });
  const { resolvedPath, digest, manifest } = inspected;
  const loaded = await import(`${pathToFileURL(resolvedPath).href}?sha256=${digest}`);
  const pack = loaded.extensionPack ?? loaded.default;
  assert(pack, 'EXTENSION_MODULE_CONTRACT_INVALID', 'Extension module must export extensionPack or a default Extension Pack.');
  const defined = defineExtensionPack({ ...pack, digest });
  if (manifest?.id) assert(manifest.id === defined.id && manifest.version === defined.version, 'EXTENSION_ARTIFACT_IDENTITY_MISMATCH', 'Extension artifact manifest identity does not match its exported Extension Pack.', { manifestId: manifest.id, extensionId: defined.id });
  if (manifest) verifiedArtifactPacks.add(defined);
  return defined;
};
