import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digestJson, sha256 } from '../common/canonical.mjs';
import { assert } from '../common/errors.mjs';
import { assertNoLinkPath } from '../common/paths.mjs';
import { cargoTestInputCandidate } from '../platform/workflow/gates/cargo-input-binding.mjs';

const safePath = path => typeof path === 'string' && path.length > 0 && !/[\\:*?\u0000]/.test(path)
  && !path.startsWith('/') && path.split('/').every(part => part && part !== '.' && part !== '..');
const inside = (root, path) => path === root || path.startsWith(`${root}/`);
const allowed = (path, scope, denied) => scope.some(root => safePath(root) && inside(root, path))
  && !denied.some(root => safePath(root) && inside(root, path));
const fileStat = async (root, path) => {
  assert(safePath(path), 'DELIVERY_INPUT_PATH_INVALID', 'Verification inputs must be safe project-relative paths.');
  try {
    const stat = await lstat(assertNoLinkPath(root, resolve(root, path), 'verification input binding'));
    assert(!stat.isSymbolicLink(), 'DELIVERY_VERIFICATION_LINK', 'Verification bindings cannot traverse links.');
    return stat;
  }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

/** Resolve logical build-target inputs, not commands, contracts or write scope. */
export const resolveVerificationInputs = async ({ check, workspaceRoot, allowedPaths = [], forbiddenPaths = [], excluded = [] }) => {
  const denied = [...forbiddenPaths, ...excluded];
  const missingInputs = [];
  const bindings = [];
  const effectiveCheck = structuredClone(check);
  const manifests = check.inputs.filter(path => path === 'Cargo.toml' || path.endsWith('/Cargo.toml'));
  for (const [index, declaredPath] of check.inputs.entries()) {
    if (await fileStat(workspaceRoot, declaredPath)) continue;
    const candidates = [];
    if (allowed(declaredPath, allowedPaths, denied)) for (const manifestPath of manifests) {
      if (!allowed(manifestPath, allowedPaths, denied)) continue;
      const stat = await fileStat(workspaceRoot, manifestPath);
      if (!stat?.isFile() || stat.size > 2 * 1024 * 1024) continue;
      const bytes = await readFile(assertNoLinkPath(workspaceRoot, resolve(workspaceRoot, manifestPath)));
      const candidate = cargoTestInputCandidate({ manifestPath, content: bytes.toString('utf8'), command: check.command, declaredPath });
      if (!candidate || !safePath(candidate.resolvedPath) || !allowed(candidate.resolvedPath, allowedPaths, denied)) continue;
      if (!(await fileStat(workspaceRoot, candidate.resolvedPath))?.isFile()) continue;
      candidates.push({ declaredPath, ...candidate, manifestPath, manifestSha256: sha256(bytes) });
    }
    if (candidates.length !== 1 || bindings.length >= 8) { missingInputs.push(declaredPath); continue; }
    const binding = candidates[0];
    effectiveCheck.inputs[index] = binding.resolvedPath;
    bindings.push(binding);
  }
  return { kind: 'verification-input-binding', version: '1.0.0', checkId: check.id,
    approvedCheckDigest: digestJson(check), effectiveCheckDigest: digestJson(effectiveCheck),
    bindings, missingInputs, effectiveCheck };
};

export const bindContinuationVerificationInputs = async ({ continuation, feature, workspaceRoot, excluded = [], additionalChecks = [] }) => {
  if (!continuation?.workBatch?.checks) return continuation;
  const checks = [...new Map([...continuation.workBatch.checks, ...additionalChecks].map(check => [digestJson(check), check])).values()];
  const resolutions = await Promise.all(checks.map(check => resolveVerificationInputs({ check,
    workspaceRoot, allowedPaths: feature.allowedPaths, forbiddenPaths: feature.forbiddenPaths, excluded })));
  const missing = resolutions.filter(item => item.missingInputs.length);
  return { ...continuation, workBatch: { ...continuation.workBatch,
    approvedChecks: structuredClone(continuation.workBatch.checks),
    checks: resolutions.slice(0, continuation.workBatch.checks.length).map(item => item.effectiveCheck),
    verificationInputBindings: resolutions,
    verificationInputBlockers: missing.map(({ checkId, missingInputs }) => ({ checkId, missingInputs })) },
    instructions: [...continuation.instructions,
      'Host resolved verification input bindings are sealed in workBatch.verificationInputBindings. Use workBatch.checks; retain the approved checks unchanged. These bindings only correct a manifest-proven logical input path, never commands, obligations, scope or budget. Missing unresolved check inputs block that check, not independent feasible implementation in this batch. Do not fabricate placeholder files; preserve the exact missing-input prerequisite while completing feasible local work.'] };
};

export const assertVerificationBindingStable = (pinned, current) => {
  if (!pinned) return;
  const identity = value => ({ approvedCheckDigest: value.approvedCheckDigest,
    bindings: value.bindings.map(({ manifestSha256: _hash, ...binding }) => binding) });
  assert(digestJson(identity(pinned)) === digestJson(identity(current)),
    'DELIVERY_INPUT_BINDING_DRIFT', 'Verification target identity changed after Dispatch; obtain a fresh binding.');
};
