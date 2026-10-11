import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { newId } from '../../common/canonical.mjs';
import { applyDevelopmentPatchPlan, createDevelopmentPatchPlan, verifyDevelopmentPatchPlan } from '../../application/development-patch.mjs';
import { recoverDevelopmentRun, refreshPendingDevelopmentCarryover } from '../../application/development-run-recovery.mjs';
import { previewDevelopmentH4Migration } from '../../application/development-h4-preflight.mjs';
import { assert } from '../../common/errors.mjs';
import { createLocalDevelopmentInvocation } from '../../application/local-development-invocation.mjs';
import { applyProjectInitializationPlan, createProjectInitializationPlan, loadProjectHarnessConfig } from '../../application/project-initialization.mjs';

const readLocalCodexBindings = async (manifestFile, manifest) => {
  const pluginRoot = resolve(manifest.dataRoot, 'development', 'local-codex');
  const bindingFile = resolve(pluginRoot, '.plugin-data', 'bindings.json');
  let existing;
  try { existing = JSON.parse(await readFile(bindingFile, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { pluginRoot, bindingFile, existing: null }; throw error; }
  if (existing.harness?.release?.mode !== 'source-link'
    || resolve(existing.harness.release.developmentManifest) !== resolve(manifestFile)
    || resolve(existing.harness.controlRoot) !== resolve(manifest.controlRoot)
    || resolve(existing.harness.dataRoot) !== resolve(manifest.dataRoot)) throw Object.assign(new Error('Local Codex binding does not match the development manifest.'), { code: 'LOCAL_CODEX_BINDING_MISMATCH' });
  return { pluginRoot, bindingFile, existing };
};

export const refreshLocalCodexBindings = async (manifestFile, manifest, initialization) => {
  if (!initialization) return null;
  const { pluginRoot, existing } = await readLocalCodexBindings(manifestFile, manifest);
  if (!existing) return null;
  const alias = initialization.receipt.hostBinding.alias;
  if (!existing.projects?.[alias]) return null;
  const projectSpecs = Object.entries(existing.projects).map(([name, project]) => `${name}|${project.projectId}|${project.profileId}|${project.extensionId}|${project.workspaceRoot}`);
  const workspaceSpecs = Object.entries(existing.workspaces ?? {}).map(([name, workspace]) => `${name}|${workspace.workspaceId}|${workspace.executionTargetId}|${workspace.workspaceRoot}`);
  const workflowSpecs = [...Object.entries(existing.projects), ...Object.entries(existing.workspaces ?? {})].flatMap(([name, binding]) =>
    (name === alias ? initialization.receipt.hostBinding.workflows : binding.workflows ?? []).map(workflow => `${name}|${workflow.id}|${workflow.version}|${workflow.artifactDigest}|${workflow.profileId}|${workflow.extensionId}`));
  const { configureBindings } = await import('../../../integrations/codex/agent-harness-codex/scripts/configure-bindings.mjs');
  const refreshed = await configureBindings({ pluginRoot, controlRoot: manifest.controlRoot, entrypoint: existing.harness.entrypoint, dataRoot: manifest.dataRoot, memoryRoot: existing.harness.memoryRoot, projectSpecs, workspaceSpecs, workflowSpecs, developmentManifest: manifestFile });
  return refreshed.bindingFile;
};

const rebind = async (manifest, { commandId, decision, developmentInvocation }) => {
  const loaded = await loadProjectHarnessConfig(manifest.configPath, { projectRoot: manifest.projectRoot });
  const releaseIdentity = { version: manifest.release.version, artifactDigest: manifest.release.artifactDigest, verified: true, development: true };
  const initPlan = await createProjectInitializationPlan(manifest.configPath, { projectRoot: loaded.projectRoot, controlRoot: manifest.controlRoot, dataRoot: manifest.dataRoot, releaseIdentity, mode: 'source-link' });
  return applyProjectInitializationPlan(initPlan, { controlRoot: manifest.controlRoot, dataRoot: manifest.dataRoot, releaseIdentity, commandId: `${commandId}.rebind`, authorityDecision: decision, developmentInvocation });
};

export const applySourcePatch = async (plan, { decision, commandId, cwd = process.cwd(), h4MigrationRunId = null, h4IdleRebind = false }) => {
  const patchManifest = JSON.parse(await readFile(resolve(plan.manifestFile), 'utf8'));
  await readLocalCodexBindings(plan.manifestFile, patchManifest);
  const developmentInvocation = decision ? null : await createLocalDevelopmentInvocation({ projectRoot: patchManifest.projectRoot, configPath: patchManifest.configPath, controlRoot: plan.controlRoot, dataRoot: plan.dataRoot, cwd });
  const patched = await applyDevelopmentPatchPlan(plan, { commandId, authorityDecision: decision, developmentInvocation, h4MigrationRunId, h4IdleRebind });
  const initialization = plan.disposition.requiresRebind ? await rebind(patched.manifest, { commandId, decision, developmentInvocation }) : null;
  const bindingFile = await refreshLocalCodexBindings(plan.manifestFile, patched.manifest, initialization);
  const carryoverRefresh = await refreshPendingDevelopmentCarryover({ manifestFile: plan.manifestFile,
    commandId: `${commandId}.carryover`, cwd });
  return { ...patched, initialization, bindingFile, carryoverRefresh,
    continuation: plan.disposition.requiresNewRun ? 'internal-recovery-required' : 'continue-same-run' };
};

/** Explicit H4 new-Run migration; ordinary dev sync never enters this route. */
export const migrateDevelopmentSource = async (manifestFile, { runId, decision = null,
  noActiveRun = false, commandId, cwd = process.cwd() } = {}) => {
  assert(commandId && Boolean(runId) !== noActiveRun, 'DEVELOPMENT_H4_MIGRATION_INPUT_REQUIRED', 'H4 migration requires a stable command ID and exactly one of an exact Run ID or --no-active-run.');
  const plan = await createDevelopmentPatchPlan(manifestFile);
  assert(plan.level === 'H4' && plan.changes.length > 0, 'DEVELOPMENT_H4_MIGRATION_NOT_REQUIRED', 'The current source has no pending H4 migration.');
  const manifest = JSON.parse(await readFile(resolve(manifestFile), 'utf8'));
  if (noActiveRun) assert(plan.activeRuns.length === 0, 'DEVELOPMENT_H4_MIGRATION_RUN_CHANGED', 'Idle H4 rebind requires no active Runs.');
  const preview = noActiveRun
    ? { bindingId: plan.bindingId, activeRuns: 0, sourceDigest: plan.after.sourceDigest }
    : await previewDevelopmentH4Migration({ plan, manifest, runId });
  const patched = await applySourcePatch(plan, { decision, commandId, cwd, h4MigrationRunId: runId, h4IdleRebind: noActiveRun });
  if (noActiveRun) return { plan, preview, ...patched, continuation: 'new-lifecycle-command-ready' };
  const recovery = await recoverDevelopmentRun({ manifestFile, runId, commandId: `${commandId}.recover`, cwd });
  return { plan, preview, ...patched, recovery,
    continuation: recovery.continuation === 'new-quality-command-ready'
      ? 'new-quality-command-ready' : 'replacement-lifecycle-command-ready' };
};

export const syncDevelopmentSource = async (manifestFile, { decision = null, commandId = newId('dev-sync'), forceRebind = false, cwd = process.cwd() } = {}) => {
  const plan = await createDevelopmentPatchPlan(manifestFile);
  if (plan.changes.length) return { plan, ...await applySourcePatch(plan, { decision, commandId, cwd }) };
  if (!forceRebind) return { unchanged: true, planDigest: plan.planDigest,
    carryoverRefresh: await refreshPendingDevelopmentCarryover({ manifestFile, commandId: `${commandId}.carryover`, cwd }),
    continuation: 'continue-same-run' };
  const { manifest } = await verifyDevelopmentPatchPlan(plan);
  await readLocalCodexBindings(plan.manifestFile, manifest);
  const developmentInvocation = decision ? null : await createLocalDevelopmentInvocation({ projectRoot: manifest.projectRoot, configPath: manifest.configPath, controlRoot: manifest.controlRoot, dataRoot: manifest.dataRoot, cwd });
  const initialization = await rebind(manifest, { commandId, decision, developmentInvocation });
  const bindingFile = await refreshLocalCodexBindings(plan.manifestFile, manifest, initialization);
  return { unchanged: true, planDigest: plan.planDigest, initialization, bindingFile, continuation: 'internal-recovery-required' };
};
