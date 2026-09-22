import { copyFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { digestJson, sha256, withoutKeys } from '../common/canonical.mjs';
import { assert } from '../common/errors.mjs';
import { atomicWriteJson, readJson } from '../kernel/atomic-io.mjs';
import { assertHarnessWritePath, harnessControlRoot, harnessProjectRoot } from '../common/write-boundary.mjs';
import { assertNoLinkPath, safeSegment } from '../common/paths.mjs';

const runtimeRoots = ['bin', 'src', 'schemas', 'profiles', 'plugins', 'integrations', 'scripts'];
const supportRoots = ['docs', 'examples', 'test'];
const runtimeRootFiles = ['package.json'];
const supportRootFiles = ['README.md'];
const ignoredDirectories = new Set(['.git', '.plugin-data', '.agent-harness-data', '.agent-harness-cache', '.tmp', 'node_modules', 'dist', 'coverage']);

const collectFiles = async (sourceRoot, current, output) => {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw Object.assign(new Error(`Development source cannot contain a linked runtime path: ${resolve(current, entry.name)}`), { code: 'DEVELOPMENT_SOURCE_LINK_FORBIDDEN' });
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = assertNoLinkPath(sourceRoot, resolve(current, entry.name), 'Development source file');
    if (entry.isDirectory()) await collectFiles(sourceRoot, absolute, output);
    else if (entry.isFile()) output.push(absolute);
  }
};

export const captureDevelopmentSourceIdentity = async ({ sourceRoot: sourceRootInput = harnessProjectRoot() } = {}) => {
  const sourceRoot = resolve(sourceRootInput);
  assert(sourceRoot === harnessProjectRoot(), 'DEVELOPMENT_SOURCE_CHECKOUT_MISMATCH', 'Source-link mode must use the exact Agent Harness checkout running this command.', { expected: harnessProjectRoot(), actual: sourceRoot });
  const packageJson = JSON.parse(await readFile(resolve(sourceRoot, 'package.json'), 'utf8'));
  const collectGroup = async (rootFiles, roots) => {
    const absoluteFiles = [];
    for (const name of rootFiles) absoluteFiles.push(assertNoLinkPath(sourceRoot, resolve(sourceRoot, name), 'Development source file'));
    for (const name of roots) {
      const directory = assertNoLinkPath(sourceRoot, resolve(sourceRoot, name), 'Development source directory');
      if ((await stat(directory)).isDirectory()) await collectFiles(sourceRoot, directory, absoluteFiles);
    }
    const files = [];
    for (const file of absoluteFiles.sort((a, b) => a.localeCompare(b))) {
      const bytes = await readFile(file);
      files.push({ path: relative(sourceRoot, file).replaceAll('\\', '/'), sha256: sha256(bytes), size: bytes.length });
    }
    return files;
  };
  const runtimeFiles = await collectGroup(runtimeRootFiles, runtimeRoots);
  const supportFiles = await collectGroup(supportRootFiles, supportRoots);
  const files = [...runtimeFiles, ...supportFiles].sort((a, b) => a.path.localeCompare(b.path));
  const runtimeDigest = digestJson(runtimeFiles);
  const supportDigest = digestJson(supportFiles);
  const sourceDigest = digestJson(files);
  return Object.freeze({
    mode: 'source-link',
    sourceRoot,
    version: packageJson.version,
    artifactDigest: runtimeDigest,
    runtimeDigest,
    supportDigest,
    sourceDigest,
    runtimeFiles,
    supportFiles,
    verified: true,
    files,
  });
};

export const developmentSourceManifestDigest = manifest => digestJson(withoutKeys(manifest, ['manifestDigest']));

export const writeDevelopmentGenerationSnapshot = async (source, { dataRoot: dataRootInput, controlRoot: controlRootInput } = {}) => {
  const controlRoot = harnessControlRoot(controlRootInput ?? source.sourceRoot);
  const dataRoot = assertHarnessWritePath(dataRootInput, 'Development data root', controlRoot);
  const generationRoot = assertHarnessWritePath(resolve(dataRoot, 'development', 'generations', source.runtimeDigest), 'Development generation root', controlRoot);
  const filesRoot = resolve(generationRoot, 'files');
  for (const item of source.runtimeFiles) {
    const sourceFile = assertNoLinkPath(source.sourceRoot, resolve(source.sourceRoot, item.path), 'Development generation source');
    const destination = assertHarnessWritePath(resolve(filesRoot, item.path), 'Development generation file', controlRoot);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(sourceFile, destination);
    const copied = await readFile(destination);
    assert(copied.length === item.size && sha256(copied) === item.sha256, 'DEVELOPMENT_GENERATION_SOURCE_DRIFT', `Harness source changed while capturing development generation: ${item.path}`);
  }
  const metadata = {
    protocolVersion: '1.0', kind: 'development-generation', sourceRoot: source.sourceRoot,
    version: source.version, runtimeDigest: source.runtimeDigest, supportDigest: source.supportDigest,
    sourceDigest: source.sourceDigest, runtimeFiles: source.runtimeFiles, filesRoot,
  };
  await atomicWriteJson(resolve(generationRoot, 'generation.json'), metadata, { root: dataRoot });
  return { generationRoot, filesRoot, metadata };
};

export const writeDevelopmentSourceManifest = async ({ bindingId, sourceRoot: sourceRootInput = harnessProjectRoot(), controlRoot: controlRootInput, dataRoot: dataRootInput, configPath, projectRoot, now = () => new Date().toISOString() } = {}) => {
  const source = await captureDevelopmentSourceIdentity({ sourceRoot: sourceRootInput });
  const controlRoot = harnessControlRoot(controlRootInput ?? source.sourceRoot);
  assert(controlRoot === source.sourceRoot, 'DEVELOPMENT_CONTROL_ROOT_MISMATCH', 'Source-link controlRoot must be the exact Harness source checkout.');
  const dataRoot = assertHarnessWritePath(dataRootInput, 'Development data root', controlRoot);
  const safeBindingId = safeSegment(bindingId, 'bindingId');
  const body = {
    protocolVersion: '1.0',
    kind: 'development-source-manifest',
    bindingId: safeBindingId,
    generation: 1,
    sourceRoot: source.sourceRoot,
    controlRoot,
    dataRoot,
    configPath: resolve(configPath),
    projectRoot: resolve(projectRoot),
    release: { mode: 'source-link', version: source.version, artifactDigest: source.artifactDigest },
    sourceIdentity: { runtimeDigest: source.runtimeDigest, supportDigest: source.supportDigest, sourceDigest: source.sourceDigest, runtimeFiles: source.runtimeFiles, supportFiles: source.supportFiles },
    entrypoint: resolve(source.sourceRoot, 'bin', 'agent-harness.mjs'),
    channels: {
      codex: {
        coordinatorEntrypoint: resolve(source.sourceRoot, 'integrations', 'codex', 'agent-harness-codex', 'scripts', 'visible-lifecycle-coordinator.mjs'),
        hostBridgeModule: resolve(source.sourceRoot, 'integrations', 'codex', 'agent-harness-codex', 'lib', 'hook-host-exchange.mjs'),
      },
    },
    files: source.files,
    createdAt: now(),
  };
  const manifest = { ...body, manifestDigest: developmentSourceManifestDigest(body) };
  const file = assertHarnessWritePath(resolve(dataRoot, 'development', 'bindings', `${safeBindingId}.json`), 'Development source manifest', controlRoot);
  await mkdir(dataRoot, { recursive: true });
  const generation = await writeDevelopmentGenerationSnapshot(source, { dataRoot, controlRoot });
  await atomicWriteJson(file, manifest, { root: dataRoot });
  await atomicWriteJson(resolve(generation.generationRoot, `${safeBindingId}.manifest.json`), manifest, { root: dataRoot });
  return { file, manifest, generation: generation.metadata };
};

export const verifyDevelopmentSourceManifest = async manifestInput => {
  const manifest = typeof manifestInput === 'string' ? await readJson(resolve(manifestInput), null) : structuredClone(manifestInput);
  assert(manifest?.protocolVersion === '1.0' && manifest.kind === 'development-source-manifest', 'DEVELOPMENT_SOURCE_MANIFEST_INVALID', 'Development source manifest is invalid.');
  assert(manifest.manifestDigest === developmentSourceManifestDigest(manifest), 'DEVELOPMENT_SOURCE_MANIFEST_DIGEST_MISMATCH', 'Development source manifest digest changed.');
  assert(isAbsolute(manifest.sourceRoot) && isAbsolute(manifest.entrypoint) && isAbsolute(manifest.dataRoot), 'DEVELOPMENT_SOURCE_MANIFEST_INVALID', 'Development source manifest requires absolute roots and entrypoint.');
  const current = await captureDevelopmentSourceIdentity({ sourceRoot: manifest.sourceRoot });
  assert(current.runtimeDigest === manifest.release.artifactDigest, 'HARNESS_SOURCE_IDENTITY_CHANGED', 'Harness runtime source changed after development binding was created; run dev patch plan before continuing.', { expected: manifest.release.artifactDigest, actual: current.runtimeDigest, supportOnly: false });
  return {
    manifest,
    releaseIdentity: { version: manifest.release.version, artifactDigest: manifest.release.artifactDigest, verified: true, development: true },
    source: current,
    supportChanged: Boolean(manifest.sourceIdentity?.supportDigest && current.supportDigest !== manifest.sourceIdentity.supportDigest),
    sourceChanged: Boolean(manifest.sourceIdentity?.sourceDigest && current.sourceDigest !== manifest.sourceIdentity.sourceDigest),
  };
};
