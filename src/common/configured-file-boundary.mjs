import { assert } from './errors.mjs';
import { safeProjectFile } from './project-file-policy.mjs';
import { cloneJson } from './clone-json.mjs';
export const validateFileBoundary = boundary => {
  assert(boundary?.version === 'project-boundary/1', 'PROJECT_BOUNDARY_REQUIRED', 'Declare project.fileBoundary explicitly.');
  for (const key of ['sourceRoots', 'sharedPaths', 'artifactRoots', 'protectedPaths']) {
    assert(Array.isArray(boundary[key]) && boundary[key].every(safeProjectFile)
      && new Set(boundary[key]).size === boundary[key].length, 'PROJECT_BOUNDARY_INVALID', `Invalid ${key}; use exact project-relative paths.`);
  }
  assert(boundary.sourceRoots.length > 0, 'PROJECT_BOUNDARY_INVALID', 'At least one owned source root is required.');
  const overlaps = (a,b) => { a=a.toLowerCase(); b=b.toLowerCase(); return a===b||a.startsWith(b+'/')||b.startsWith(a+'/'); };
  assert(!boundary.artifactRoots.some(a => [...boundary.sourceRoots,...boundary.sharedPaths,...boundary.protectedPaths].some(b=>overlaps(a,b))),
    'PROJECT_BOUNDARY_OVERLAP', 'Artifact roots cannot overlap source, shared or protected paths.');
  return cloneJson(boundary);
};
export const applyConfiguredFileBoundary = (descriptor, boundary) => {
  if (!boundary) return descriptor; // Legacy configuration retains its original strict contract.
  const value=validateFileBoundary(boundary);
  return {...descriptor, policy:{...descriptor.policy,
    projectFilePolicy:{version:'project-files/1',mode:'project-owned',roots:[...value.sourceRoots,...value.sharedPaths],protectedPaths:value.protectedPaths,artifactRoots:value.artifactRoots},
    qualityVerificationOutputs:value.artifactRoots, configuredFileBoundary:value}};
};
