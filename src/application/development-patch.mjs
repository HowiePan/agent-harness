import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digestJson, withoutKeys } from '../common/canonical.mjs';
import { assert } from '../common/errors.mjs';
import { atomicWriteJson, readJson } from '../kernel/atomic-io.mjs';
import { AuthorityStore } from '../kernel/authority-store.mjs';
import { assertHarnessWritePath, harnessControlRoot } from '../common/write-boundary.mjs';
import { safeSegment } from '../common/paths.mjs';
import { assertLocalDevelopmentInvocation, decisionFromLocalDevelopmentInvocation } from './local-development-invocation.mjs';
import {
  captureDevelopmentSourceIdentity,
  developmentSourceManifestDigest,
  writeDevelopmentGenerationSnapshot,
} from './development-source.mjs';

const levels = Object.freeze({ H0: 0, H1: 1, H2: 2, H3: 3, H4: 4 });
const terminalRunStates = new Set(['closed', 'superseded']);

const classifyPath = path => {
  if (path === 'README.md' || /^(?:docs|examples|test)\//.test(path)) return { level: 'H0', impact: 'support-only' };
  if (/^(?:src\/kernel|schemas\/(?:authority|result|command)|src\/kernel\/atomic-io|src\/platform\/(?:registry|recovery))/.test(path)) return { level: 'H4', impact: 'authority-or-persistence-contract' };
  if (/^src\/flows\/[^/]+\/(?:graph|nodes)\//.test(path)) return { level: 'H1', impact: 'future-plan-template' };
  if (/^(?:src\/flows|profiles|src\/platform\/workflow|integrations\/legacy-consumers|scripts)\//.test(path)) return { level: 'H2', impact: 'active-policy-or-gate-implementation' };
  if (/^(?:bin|src\/application|src\/interfaces|src\/platform\/plugins|integrations\/(?:codex|opencode|vscode)|plugins)\//.test(path) || path === 'package.json') return { level: 'H3', impact: 'coordinator-or-runtime-process' };
  return { level: 'H3', impact: 'unclassified-runtime' };
};

const fileMap = files => new Map((files ?? []).map(item => [item.path, item]));

export const diffDevelopmentFiles = (beforeFiles, afterFiles) => {
  const before = fileMap(beforeFiles);
  const after = fileMap(afterFiles);
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap(path => {
    const left = before.get(path) ?? null;
    const right = after.get(path) ?? null;
    if (left?.sha256 === right?.sha256 && left?.size === right?.size) return [];
    const classification = classifyPath(path);
    return [{ path, change: !left ? 'added' : !right ? 'removed' : 'modified', before: left, after: right, ...classification }];
  });
};

const activeRunSummary = async ({ dataRoot, controlRoot }) => {
  const store = new AuthorityStore({ root: dataRoot, controlRoot });
  const runs = (await store.listAll()).filter(run => !terminalRunStates.has(run.status));
  return runs.map(run => ({
    projectId: run.projectId,
    runId: run.runId,
    status: run.status,
    revision: run.revision,
    epoch: run.epoch,
    generation: run.generation,
    activeLeaseIds: (run.leases ?? []).filter(lease => lease.status === 'active').map(lease => lease.leaseId).sort(),
    activeDispatchIds: (run.dispatches ?? []).filter(dispatch => ['requested', 'assigned'].includes(dispatch.status)).map(dispatch => dispatch.dispatchId).sort(),
  })).sort((left, right) => `${left.projectId}/${left.runId}`.localeCompare(`${right.projectId}/${right.runId}`));
};

const readManifest = async input => {
  const file = resolve(input);
  const manifest = await readJson(file, null);
  assert(manifest?.protocolVersion === '1.0' && manifest.kind === 'development-source-manifest', 'DEVELOPMENT_SOURCE_MANIFEST_INVALID', 'Development source manifest is invalid.');
  assert(manifest.manifestDigest === developmentSourceManifestDigest(manifest), 'DEVELOPMENT_SOURCE_MANIFEST_DIGEST_MISMATCH', 'Development source manifest digest changed.');
  return { file, manifest };
};

export const developmentPatchPlanDigest = plan => digestJson(withoutKeys(plan, ['planDigest']));
export const developmentPatchReceiptDigest = receipt => digestJson(withoutKeys(receipt, ['receiptDigest']));

export const createDevelopmentPatchPlan = async manifestInput => {
  const { file, manifest } = await readManifest(manifestInput);
  const current = await captureDevelopmentSourceIdentity({ sourceRoot: manifest.sourceRoot });
  const changes = diffDevelopmentFiles(manifest.files, current.files);
  const level = changes.reduce((highest, change) => levels[change.level] > levels[highest] ? change.level : highest, 'H0');
  const runs = await activeRunSummary({ dataRoot: manifest.dataRoot, controlRoot: manifest.controlRoot });
  const runtimeChanged = current.runtimeDigest !== manifest.release.artifactDigest;
  const supportChanged = current.supportDigest !== manifest.sourceIdentity?.supportDigest;
  const body = {
    protocolVersion: '1.0', kind: 'development-patch-plan', bindingId: manifest.bindingId,
    manifestFile: file, manifestDigest: manifest.manifestDigest,
    sourceRoot: manifest.sourceRoot, dataRoot: manifest.dataRoot, controlRoot: manifest.controlRoot,
    before: {
      runtimeDigest: manifest.release.artifactDigest,
      supportDigest: manifest.sourceIdentity?.supportDigest ?? null,
      sourceDigest: manifest.sourceIdentity?.sourceDigest ?? null,
    },
    after: { runtimeDigest: current.runtimeDigest, supportDigest: current.supportDigest, sourceDigest: current.sourceDigest },
    runtimeChanged, supportChanged, level, changes, activeRuns: runs,
    disposition: level === 'H0'
      ? { sameRun: true, requiresRebind: false, requiresCoordinatorRestart: false, requiresNewRun: false }
      : level === 'H1'
        ? { sameRun: true, requiresRebind: true, requiresCoordinatorRestart: false, requiresNewRun: false }
        : { sameRun: false, requiresRebind: true, requiresCoordinatorRestart: true, requiresNewRun: true },
  };
  return { ...body, planDigest: developmentPatchPlanDigest(body) };
};

export const verifyDevelopmentPatchPlan = async plan => {
  assert(plan?.protocolVersion === '1.0' && plan.kind === 'development-patch-plan', 'DEVELOPMENT_PATCH_PLAN_INVALID', 'Development patch plan is invalid.');
  assert(plan.planDigest === developmentPatchPlanDigest(plan), 'DEVELOPMENT_PATCH_PLAN_DIGEST_MISMATCH', 'Development patch plan digest changed.');
  const { manifest } = await readManifest(plan.manifestFile);
  assert(manifest.manifestDigest === plan.manifestDigest, 'DEVELOPMENT_PATCH_PLAN_STALE', 'Development binding changed after patch planning.');
  const current = await captureDevelopmentSourceIdentity({ sourceRoot: plan.sourceRoot });
  assert(current.runtimeDigest === plan.after.runtimeDigest && current.supportDigest === plan.after.supportDigest && current.sourceDigest === plan.after.sourceDigest, 'DEVELOPMENT_PATCH_SOURCE_CHANGED', 'Harness source changed after patch planning.');
  return { plan: structuredClone(plan), manifest, current };
};

export const applyDevelopmentPatchPlan = async (planInput, { commandId, authorityDecision, developmentInvocation = null, now = () => new Date().toISOString() } = {}) => {
  const { plan, manifest, current } = await verifyDevelopmentPatchPlan(planInput);
  assert(commandId, 'COMMAND_ID_REQUIRED', 'Development patch apply requires a command ID.');
  assert(plan.changes.length > 0, 'DEVELOPMENT_PATCH_NOT_REQUIRED', 'Harness source matches the active development binding; no patch is required.');
  assert(plan.level !== 'H4', 'DEVELOPMENT_PATCH_INCOMPATIBLE', 'H4 changes require an explicit state migration or a new Run and cannot be hot-applied.', { changes: plan.changes.map(change => change.path) });
  if (developmentInvocation) assertLocalDevelopmentInvocation(developmentInvocation, { projectRoot: manifest.projectRoot, configPath: manifest.configPath, controlRoot: plan.controlRoot, dataRoot: plan.dataRoot });
  const resolvedDecision = authorityDecision ?? (developmentInvocation ? decisionFromLocalDevelopmentInvocation(developmentInvocation, { action: 'development-patch', planDigest: plan.planDigest, commandId, bindingId: plan.bindingId, beforeRuntimeDigest: plan.before.runtimeDigest, afterRuntimeDigest: plan.after.runtimeDigest, level: plan.level }) : null);
  if (plan.level !== 'H0') assert(resolvedDecision?.actor && resolvedDecision?.decision === 'approved', 'DEVELOPMENT_PATCH_DECISION_REQUIRED', 'Runtime development patches require an approved Authority Decision or a local development invocation.');
  const controlRoot = harnessControlRoot(plan.controlRoot);
  const dataRoot = assertHarnessWritePath(plan.dataRoot, 'Development data root', controlRoot);
  const safeCommandId = safeSegment(commandId, 'commandId');
  const generation = await writeDevelopmentGenerationSnapshot(current, { dataRoot, controlRoot });
  const previousGenerationRoot = assertHarnessWritePath(resolve(dataRoot, 'development', 'generations', manifest.release.artifactDigest), 'Previous development generation', controlRoot);
  await mkdir(previousGenerationRoot, { recursive: true });
  await atomicWriteJson(resolve(previousGenerationRoot, `${manifest.bindingId}.manifest.json`), manifest, { root: dataRoot });
  const generationNumber = Number.isInteger(manifest.generation) ? manifest.generation + 1 : 2;
  const nextBody = {
    ...withoutKeys(manifest, ['manifestDigest']),
    release: { ...manifest.release, artifactDigest: current.runtimeDigest },
    sourceIdentity: { runtimeDigest: current.runtimeDigest, supportDigest: current.supportDigest, sourceDigest: current.sourceDigest, runtimeFiles: current.runtimeFiles, supportFiles: current.supportFiles },
    files: current.files,
    generation: generationNumber,
    parentManifestDigest: manifest.manifestDigest,
    patchedAt: now(),
  };
  const next = { ...nextBody, manifestDigest: developmentSourceManifestDigest(nextBody) };
  await atomicWriteJson(plan.manifestFile, next, { root: dataRoot });
  await atomicWriteJson(resolve(generation.generationRoot, `${manifest.bindingId}.manifest.json`), next, { root: dataRoot });
  const receiptBody = {
    protocolVersion: '1.0', kind: 'development-patch-receipt', commandId: safeCommandId,
    bindingId: manifest.bindingId, planDigest: plan.planDigest, level: plan.level,
    beforeRuntimeDigest: plan.before.runtimeDigest, afterRuntimeDigest: plan.after.runtimeDigest,
    generation: generationNumber, sameRun: plan.disposition.sameRun,
    requiresCoordinatorRestart: plan.disposition.requiresCoordinatorRestart,
    affectedRuns: plan.activeRuns, changes: plan.changes.map(({ path, change, level, impact }) => ({ path, change, level, impact })),
    authorityDecision: resolvedDecision ? structuredClone(resolvedDecision) : null,
    appliedAt: now(), manifestDigest: next.manifestDigest,
  };
  const receipt = { ...receiptBody, receiptDigest: developmentPatchReceiptDigest(receiptBody) };
  const receiptFile = assertHarnessWritePath(resolve(dataRoot, 'development', 'patches', `${safeCommandId}.json`), 'Development patch receipt', controlRoot);
  await atomicWriteJson(receiptFile, receipt, { root: dataRoot });
  return { manifest: next, receipt, receiptFile, generation: generation.metadata };
};

export const rollbackDevelopmentPatch = async ({ manifestFile, targetManifestFile, commandId, authorityDecision, developmentInvocation = null, now = () => new Date().toISOString() } = {}) => {
  assert(commandId, 'COMMAND_ID_REQUIRED', 'Development rollback requires a command ID.');
  const currentBinding = await readManifest(manifestFile);
  if (developmentInvocation) assertLocalDevelopmentInvocation(developmentInvocation, { projectRoot: currentBinding.manifest.projectRoot, configPath: currentBinding.manifest.configPath, controlRoot: currentBinding.manifest.controlRoot, dataRoot: currentBinding.manifest.dataRoot });
  const resolvedDecision = authorityDecision ?? (developmentInvocation ? decisionFromLocalDevelopmentInvocation(developmentInvocation, { action: 'development-patch-rollback', planDigest: currentBinding.manifest.manifestDigest, commandId, bindingId: currentBinding.manifest.bindingId }) : null);
  assert(resolvedDecision?.actor && resolvedDecision?.decision === 'approved', 'DEVELOPMENT_PATCH_DECISION_REQUIRED', 'Development rollback requires an approved Authority Decision or a local development invocation.');
  const target = await readManifest(targetManifestFile);
  assert(currentBinding.manifest.bindingId === target.manifest.bindingId, 'DEVELOPMENT_PATCH_ROLLBACK_BINDING_MISMATCH', 'Rollback target belongs to another development binding.');
  const source = await captureDevelopmentSourceIdentity({ sourceRoot: currentBinding.manifest.sourceRoot });
  assert(source.runtimeDigest === target.manifest.release.artifactDigest, 'DEVELOPMENT_PATCH_ROLLBACK_SOURCE_MISMATCH', 'Restore the target source generation in the checkout before rolling back its binding.', { expected: target.manifest.release.artifactDigest, actual: source.runtimeDigest });
  const dataRoot = currentBinding.manifest.dataRoot;
  const body = {
    ...withoutKeys(target.manifest, ['manifestDigest']),
    generation: (currentBinding.manifest.generation ?? 1) + 1,
    parentManifestDigest: currentBinding.manifest.manifestDigest,
    patchedAt: now(),
  };
  const next = { ...body, manifestDigest: developmentSourceManifestDigest(body) };
  await atomicWriteJson(currentBinding.file, next, { root: dataRoot });
  const receiptBody = {
    protocolVersion: '1.0', kind: 'development-patch-rollback-receipt',
    commandId: safeSegment(commandId, 'commandId'), bindingId: next.bindingId,
    fromManifestDigest: currentBinding.manifest.manifestDigest, toManifestDigest: next.manifestDigest,
    runtimeDigest: next.release.artifactDigest, authorityDecision: structuredClone(resolvedDecision), rolledBackAt: now(),
  };
  const receipt = { ...receiptBody, receiptDigest: developmentPatchReceiptDigest(receiptBody) };
  const receiptFile = resolve(dataRoot, 'development', 'patches', `${safeSegment(commandId, 'commandId')}.json`);
  await atomicWriteJson(receiptFile, receipt, { root: dataRoot });
  return { manifest: next, receipt, receiptFile };
};
