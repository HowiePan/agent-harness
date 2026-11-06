import { resolve } from 'node:path';
import { assert } from './errors.mjs';
import { assertNoLinkPath } from './paths.mjs';

export const safeProjectFile = value => typeof value === 'string' && value.length > 0
  && !/[\\:*?\x00-\x1f]/.test(value) && !value.startsWith('/')
  && value.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part));
const comparable = value => process.platform === 'win32' ? value.toLowerCase() : value;
const within = (root, path) => root === '.' || comparable(path) === comparable(root)
  || comparable(path).startsWith(`${comparable(root)}/`);
const legacyWithin = (root, path) => path === root || path.startsWith(`${root.replace(/\/$/, '')}/`);
export const readOnlyFeature = feature => (feature.metadata?.sourcePolicy !== 'write' && feature.allowedPaths?.length === 0)
  || feature.metadata?.sourcePolicy === 'read-only' || feature.metadata?.qualityReview === true
  || feature.kind === 'execution-diagnostic';

export const validateProjectFilePolicy = policy => {
  if (policy == null) return null;
  assert(policy.version === 'project-files/1' && policy.mode === 'project-owned'
    && Array.isArray(policy.roots) && policy.roots.length > 0
    && policy.roots.every(path => path === '.' || safeProjectFile(path))
    && Array.isArray(policy.protectedPaths) && policy.protectedPaths.every(safeProjectFile)
    && (policy.artifactRoots === undefined || Array.isArray(policy.artifactRoots) && policy.artifactRoots.every(safeProjectFile)),
  'PROJECT_FILE_POLICY_INVALID', 'Project file policy requires explicit owned roots and protected paths.');
  return structuredClone(policy);
};

export const assertFeatureFileAccess = ({ feature, policy, path, workspaceRoot = null }) => {
  assert(safeProjectFile(path), 'FEATURE_FILE_PATH_INVALID', `Unsafe project-relative file: ${path}`);
  if (policy) {
    assert(!readOnlyFeature(feature), 'FEATURE_READ_ONLY', `Feature ${feature.id} is read-only.`);
    validateProjectFilePolicy(policy);
    assert(policy.roots.some(root => within(root, path)), 'PROJECT_FILE_OUTSIDE_BOUNDARY', `File is outside this project's owned roots: ${path}`);
    assert(!['.git', '.agent-harness-data', ...policy.protectedPaths].some(root => within(root, path)),
      'PROJECT_FILE_PROTECTED', `File is protected: ${path}`);
  } else {
    assert(feature.allowedPaths.some(root => legacyWithin(root, path)), 'FEATURE_PATH_NOT_ALLOWED', `Feature ${feature.id} changed an unauthorized path: ${path}`);
    assert(!feature.forbiddenPaths.some(root => legacyWithin(root, path)), 'FEATURE_PATH_FORBIDDEN', `Feature ${feature.id} changed a forbidden path: ${path}`);
  }
  if (workspaceRoot) assertNoLinkPath(workspaceRoot, resolve(workspaceRoot, path), 'Project file change');
};

export const projectPathAdjustments = ({ feature, policy, changedFiles, result }) => {
  if (!policy) return [];
  const deviations = changedFiles.filter(path => !feature.allowedPaths.some(root => within(root, path))
    || feature.forbiddenPaths.some(root => within(root, path)));
  const adjustments = result.scopeAdjustments ?? [];
  assert(adjustments.every(item => changedFiles.includes(item.path)), 'PROJECT_SCOPE_ADJUSTMENT_INVALID', 'Scope explanations must refer to actual changed files.');
  return deviations.map(path => {
    const explanation = adjustments.find(item => item.path === path);
    const reason = explanation?.reason ?? result.summary;
    assert(typeof reason === 'string' && reason.trim().length > 0,
      'PROJECT_SCOPE_EXPLANATION_REQUIRED', `Explain how the project-local adjustment serves the current acceptance: ${path}`);
    return { path, reason };
  });
};

// The native Host has no pre-write per-file claim API. Acquire a project writer
// slot conservatively; do not pretend post-hoc changedFiles prevent collisions.
export const projectWritersConflict = (left, right, policy) => Boolean(policy
  && !readOnlyFeature(left) && !readOnlyFeature(right));
