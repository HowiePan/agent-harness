import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { newId } from '../../common/canonical.mjs';
import { applyDevelopmentPatchPlan, createDevelopmentPatchPlan, verifyDevelopmentPatchPlan } from '../../application/development-patch.mjs';
import { createLocalDevelopmentInvocation } from '../../application/local-development-invocation.mjs';
import { applyProjectInitializationPlan, createProjectInitializationPlan, loadProjectHarnessConfig } from '../../application/project-initialization.mjs';

export const refreshLocalCodexBindings = async (manifestFile, manifest, initialization) => {
  if (!initialization) return null;
  const pluginRoot = resolve(manifest.dataRoot, 'development', 'local-codex');
  const bindingFile = resolve(pluginRoot, '.plugin-data', 'bindings.json');
  let existing;
  try { existing = JSON.parse(await readFile(bindingFile, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (existing.harness?.release?.mode !== 'source-link'
    || resolve(existing.harness.release.developmentManifest) !== resolve(manifestFile)
    || resolve(existing.harness.controlRoot) !== resolve(manifest.controlRoot)
    || resolve(existing.harness.dataRoot) !== resolve(manifest.dataRoot)) throw Object.assign(new Error('Local Codex binding does not match the development manifest.'), { code: 'LOCAL_CODEX_BINDING_MISMATCH' });
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

export const applySourcePatch = async (plan, { decision, commandId, cwd = process.cwd() }) => {
  const patchManifest = JSON.parse(await readFile(resolve(plan.manifestFile), 'utf8'));
  const developmentInvocation = decision ? null : await createLocalDevelopmentInvocation({ projectRoot: patchManifest.projectRoot, configPath: patchManifest.configPath, controlRoot: plan.controlRoot, dataRoot: plan.dataRoot, cwd });
  const patched = await applyDevelopmentPatchPlan(plan, { commandId, authorityDecision: decision, developmentInvocation });
  const initialization = plan.disposition.requiresRebind ? await rebind(patched.manifest, { commandId, decision, developmentInvocation }) : null;
  const bindingFile = await refreshLocalCodexBindings(plan.manifestFile, patched.manifest, initialization);
  return { ...patched, initialization, bindingFile, continuation: plan.disposition.requiresNewRun ? 'restart-coordinator-and-start-new-run' : 'continue-same-run' };
};

export const syncDevelopmentSource = async (manifestFile, { decision = null, commandId = newId('dev-sync'), forceRebind = false, cwd = process.cwd() } = {}) => {
  const plan = await createDevelopmentPatchPlan(manifestFile);
  if (plan.changes.length) return { plan, ...await applySourcePatch(plan, { decision, commandId, cwd }) };
  if (!forceRebind) return { unchanged: true, planDigest: plan.planDigest, continuation: 'continue-same-run' };
  const { manifest } = await verifyDevelopmentPatchPlan(plan);
  const developmentInvocation = decision ? null : await createLocalDevelopmentInvocation({ projectRoot: manifest.projectRoot, configPath: manifest.configPath, controlRoot: manifest.controlRoot, dataRoot: manifest.dataRoot, cwd });
  const initialization = await rebind(manifest, { commandId, decision, developmentInvocation });
  const bindingFile = await refreshLocalCodexBindings(plan.manifestFile, manifest, initialization);
  return { unchanged: true, planDigest: plan.planDigest, initialization, bindingFile, continuation: 'restart-coordinator-and-start-new-run' };
};
