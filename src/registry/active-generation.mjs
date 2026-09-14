import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { readJson } from '../kernel/atomic-io.mjs';
import { assert } from '../errors.mjs';
import { digestJson, withoutKeys } from '../canonical.mjs';
import { assertHarnessWritePath, harnessControlRoot } from '../write-boundary.mjs';

export const activeReleaseFile = dataRoot => resolve(dataRoot, 'registry', 'active-release.json');

export const resolveActiveRegistryRoot = async (dataRootInput, controlRootInput) => {
  const controlRoot = harnessControlRoot(controlRootInput);
  const dataRoot = assertHarnessWritePath(dataRootInput, 'Registry data root', controlRoot);
  const registryRoot = resolve(dataRoot, 'registry');
  const pointer = await readJson(activeReleaseFile(dataRoot), null);
  if (!pointer) return registryRoot;
  assert(pointer.protocolVersion === '1.0' && pointer.kind === 'active-release' && /^[A-Za-z0-9._-]{1,128}$/.test(pointer.generationId ?? ''), 'ACTIVE_RELEASE_POINTER_INVALID', 'Active release pointer is invalid.');
  assert(pointer.pointerDigest === digestJson(withoutKeys(pointer, ['pointerDigest'])), 'ACTIVE_RELEASE_POINTER_DIGEST_MISMATCH', 'Active release pointer digest does not match its contents.');
  const generationRoot = resolve(registryRoot, 'generations', pointer.generationId);
  assertHarnessWritePath(generationRoot, 'Active release generation', controlRoot);
  assert(existsSync(resolve(generationRoot, 'extensions.json')) && existsSync(resolve(generationRoot, 'projects')), 'ACTIVE_RELEASE_GENERATION_MISSING', 'Active release pointer does not resolve to a complete Registry generation.');
  return generationRoot;
};
