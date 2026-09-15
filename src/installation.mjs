import { mkdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { atomicWriteJson, readJson } from './kernel/atomic-io.mjs';
import { assert } from './errors.mjs';
import { harnessProjectRoot, installationMarkerName } from './write-boundary.mjs';

const insideOrEqual = (root, target) => {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

export const initializeHarnessInstallation = async ({ controlRoot, now = () => new Date().toISOString() }) => {
  assert(controlRoot, 'HARNESS_CONTROL_ROOT_REQUIRED', 'Installation initialization requires an explicit standalone control root.');
  const root = resolve(controlRoot);
  const runtimeRoot = harnessProjectRoot();
  if (process.platform === 'win32') assert(!/^c:[\\/]/i.test(root), 'HARNESS_SYSTEM_DRIVE_FORBIDDEN', 'The Agent Harness control root may not be located on the Windows C drive.', { root });
  assert(root !== runtimeRoot, 'HARNESS_INSTALLATION_INIT_UNNECESSARY', 'A source checkout is already its own standalone control root.');
  assert(insideOrEqual(root, runtimeRoot), 'HARNESS_RUNTIME_OUTSIDE_CONTROL_ROOT', 'The runtime must be inside the standalone control root.', { root, runtimeRoot });
  await mkdir(root, { recursive: true });
  const markerPath = resolve(root, installationMarkerName);
  const existing = await readJson(markerPath, null);
  const marker = {
    protocolVersion: '1.0',
    runtimeRoot: relative(root, runtimeRoot).replaceAll('\\', '/'),
    dataRoot: '.agent-harness-data',
    temporaryRoot: '.tmp',
    initializedAt: existing?.initializedAt ?? now(),
  };
  await atomicWriteJson(markerPath, marker, { root });
  return { root, markerPath, marker };
};

export const activateHarnessInstallationRuntime = async ({ controlRoot, runtimeRoot: runtimeRootInput, now = () => new Date().toISOString() }) => {
  const root = resolve(controlRoot);
  const runtimeRoot = resolve(runtimeRootInput);
  assert(root !== runtimeRoot && insideOrEqual(root, runtimeRoot), 'HARNESS_RUNTIME_OUTSIDE_CONTROL_ROOT', 'The activated runtime must be a child of the standalone control root.', { root, runtimeRoot });
  const markerPath = resolve(root, installationMarkerName);
  const existing = await readJson(markerPath, null);
  const marker = {
    protocolVersion: '1.0',
    runtimeRoot: relative(root, runtimeRoot).replaceAll('\\', '/'),
    dataRoot: '.agent-harness-data',
    temporaryRoot: '.tmp',
    initializedAt: existing?.initializedAt ?? now(),
  };
  await atomicWriteJson(markerPath, marker, { root });
  return { root, markerPath, marker };
};
