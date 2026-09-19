import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { readJson } from '../../kernel/atomic-io.mjs';
import { assert } from '../../common/errors.mjs';
import { digestJson, withoutKeys } from '../../common/canonical.mjs';
import { assertHarnessWritePath, harnessControlRoot } from '../../common/write-boundary.mjs';

export const activeReleaseFile = dataRoot => resolve(dataRoot, 'registry', 'active-release.json');

export const readActiveRelease = async (dataRootInput, controlRootInput) => {
  const controlRoot = harnessControlRoot(controlRootInput);
  const dataRoot = assertHarnessWritePath(dataRootInput, 'Registry data root', controlRoot);
  const pointer = await readJson(activeReleaseFile(dataRoot), null);
  if (!pointer) return null;
  assert(pointer.protocolVersion === '1.0' && pointer.kind === 'active-release' && /^[A-Za-z0-9._-]{1,128}$/.test(pointer.generationId ?? ''), 'ACTIVE_RELEASE_POINTER_INVALID', 'Active release pointer is invalid.');
  assert(pointer.pointerDigest === digestJson(withoutKeys(pointer, ['pointerDigest'])), 'ACTIVE_RELEASE_POINTER_DIGEST_MISMATCH', 'Active release pointer digest does not match its contents.');
  return pointer;
};

export const resolveActiveRegistryRoot = async (dataRootInput, controlRootInput) => {
  const controlRoot = harnessControlRoot(controlRootInput);
  const dataRoot = assertHarnessWritePath(dataRootInput, 'Registry data root', controlRoot);
  const registryRoot = resolve(dataRoot, 'registry');
  const pointer = await readActiveRelease(dataRoot, controlRoot);
  if (!pointer) return registryRoot;
  const generationRoot = resolve(registryRoot, 'generations', pointer.generationId);
  assertHarnessWritePath(generationRoot, 'Active release generation', controlRoot);
  assert(existsSync(resolve(generationRoot, 'extensions.json')) && existsSync(resolve(generationRoot, 'projects')), 'ACTIVE_RELEASE_GENERATION_MISSING', 'Active release pointer does not resolve to a complete Registry generation.');
  return generationRoot;
};

export const resolveActiveRuntimeRoot = async (dataRootInput, controlRootInput) => {
  const controlRoot = harnessControlRoot(controlRootInput);
  const pointer = await readActiveRelease(dataRootInput, controlRoot);
  if (!pointer?.runtimeRoot) return controlRoot;
  assert(!isAbsolute(pointer.runtimeRoot), 'ACTIVE_RELEASE_RUNTIME_ROOT_INVALID', 'Active release runtimeRoot must be relative to the standalone control root.');
  const runtimeRoot = resolve(controlRoot, pointer.runtimeRoot);
  const rel = relative(controlRoot, runtimeRoot);
  assert(rel && !rel.startsWith('..') && !isAbsolute(rel), 'ACTIVE_RELEASE_RUNTIME_ROOT_INVALID', 'Active release runtimeRoot escapes the standalone control root.');
  assert(existsSync(resolve(runtimeRoot, 'release-manifest.json')) && existsSync(resolve(runtimeRoot, 'bin', 'agent-harness.mjs')), 'ACTIVE_RELEASE_RUNTIME_MISSING', 'Active release runtimeRoot is incomplete.');
  return runtimeRoot;
};
