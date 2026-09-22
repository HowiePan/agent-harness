import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert } from './errors.mjs';
import { assertNoLinkPath } from './paths.mjs';

export const harnessProjectRoot = () => resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const installationMarker = '.agent-harness-installation.json';
const insideOrEqual = (root, target) => {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

const packageIsInstalledDependency = () => harnessProjectRoot().split(sep).some(segment => segment.toLowerCase() === 'node_modules');

export const harnessControlRoot = input => {
  const packageRoot = harnessProjectRoot();
  if (input === undefined && packageIsInstalledDependency()) {
    assert(false, 'HARNESS_CONTROL_ROOT_REQUIRED', 'A packaged Agent Harness requires an explicit standalone control root. Do not use a business repository as the control root.');
  }
  const root = resolve(input ?? packageRoot);
  if (process.platform === 'win32') assert(!/^c:[\\/]/i.test(root), 'HARNESS_SYSTEM_DRIVE_FORBIDDEN', 'The Agent Harness control root may not be located on the Windows C drive.', { root });
  assert(existsSync(root) && !lstatSync(root).isSymbolicLink(), 'HARNESS_CONTROL_ROOT_LINK_FORBIDDEN', 'The Agent Harness control root must be an existing physical directory, not a symbolic link or junction.', { root });
  const realRoot = realpathSync.native(root);
  assert(realRoot === root || (['win32', 'darwin'].includes(process.platform) && realRoot.toLowerCase() === root.toLowerCase()), 'HARNESS_CONTROL_ROOT_LINK_FORBIDDEN', 'The Agent Harness control root path may not traverse symbolic links or junctions.', { root, realRoot });
  if (process.platform === 'win32') assert(!/^c:[\\/]/i.test(realRoot), 'HARNESS_SYSTEM_DRIVE_FORBIDDEN', 'The Agent Harness control root may not be located on the Windows C drive.', { root: realRoot });
  assert(insideOrEqual(root, packageRoot), 'HARNESS_RUNTIME_OUTSIDE_CONTROL_ROOT', 'The Agent Harness runtime must be contained by its standalone control root.', { root, packageRoot });
  if (root !== packageRoot) {
    const markerPath = resolve(root, installationMarker);
    assert(existsSync(markerPath), 'HARNESS_INSTALLATION_NOT_INITIALIZED', 'The standalone control root has not been initialized.', { root, markerPath });
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    assert(marker.protocolVersion === '1.0' && marker.runtimeRoot === relative(root, packageRoot).replaceAll('\\', '/'), 'HARNESS_INSTALLATION_INVALID', 'The standalone installation marker does not match this runtime.', { root, packageRoot });
  }
  return root;
};

export const assertHarnessWritePath = (path, label = 'write path', controlRoot = undefined) => {
  const root = harnessControlRoot(controlRoot);
  const target = resolve(path);
  const rel = relative(root, target);
  assert(target !== root && rel && !rel.startsWith('..') && !isAbsolute(rel), 'HARNESS_WRITE_OUTSIDE_PROJECT', `${label} must be inside the Agent Harness standalone control root.`, { root, target });
  return assertNoLinkPath(root, target, label);
};

export const harnessTemporaryRoot = (controlRoot = undefined) => {
  const root = harnessControlRoot(controlRoot);
  return assertHarnessWritePath(resolve(root, '.tmp'), 'temporary root', root);
};

export const temporaryEnvironment = (path, controlRoot = undefined) => {
  const target = assertHarnessWritePath(path, 'process temporary directory', controlRoot);
  return { TEMP: target, TMP: target, TMPDIR: target };
};

export const installationMarkerName = installationMarker;
