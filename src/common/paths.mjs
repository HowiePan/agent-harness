import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { assert } from './errors.mjs';

const segmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const safeSegment = (value, label = 'identifier') => {
  const segment = String(value ?? '');
  assert(segmentPattern.test(segment) && segment !== '.' && segment !== '..', 'IDENTIFIER_INVALID', `${label} is not a safe identifier.`, { value });
  return segment;
};

export const assertInside = (root, target, label = 'path') => {
  const base = resolve(root);
  const candidate = resolve(target);
  const rel = relative(base, candidate);
  assert(rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)), 'PATH_OUTSIDE_ROOT', `${label} must remain inside the managed root.`, { root: base, target: candidate });
  return candidate;
};

export const assertNoLinkPath = (root, target, label = 'path') => {
  const candidate = assertInside(root, target, label);
  const base = resolve(root);
  assert(existsSync(base), 'MANAGED_ROOT_NOT_FOUND', `${label} root does not exist.`, { root: base });
  const baseReal = realpathSync.native(base);
  assert(baseReal === base || (process.platform === 'win32' && baseReal.toLowerCase() === base.toLowerCase()), 'MANAGED_ROOT_LINK_FORBIDDEN', `${label} root may not contain symbolic links or junctions.`, { root: base, realRoot: baseReal });
  let existing = candidate;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    assert(parent !== existing, 'PATH_EXISTING_ANCESTOR_NOT_FOUND', `${label} has no existing managed ancestor.`, { target: candidate });
    existing = parent;
  }
  const projected = resolve(realpathSync.native(existing), relative(existing, candidate));
  assertInside(baseReal, projected, label);
  const rel = relative(base, existing);
  let cursor = base;
  for (const segment of rel ? rel.split(sep) : []) {
    cursor = resolve(cursor, segment);
    assert(!lstatSync(cursor).isSymbolicLink(), 'MANAGED_PATH_LINK_FORBIDDEN', `${label} may not traverse a symbolic link or junction.`, { path: cursor });
  }
  if (existing === candidate) assert(!lstatSync(existing).isSymbolicLink(), 'MANAGED_PATH_LINK_FORBIDDEN', `${label} may not be a symbolic link or junction.`, { path: existing });
  return candidate;
};

export const slash = value => String(value).replaceAll('\\', '/');
