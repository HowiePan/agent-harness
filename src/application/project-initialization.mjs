import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { assertJsonSchema } from '../common/json-schema.mjs';
import { assert } from '../common/errors.mjs';
import { digestJson, sha256, withoutKeys } from '../common/canonical.mjs';
import { applyBootstrapPlan, createBootstrapPlan } from './bootstrap.mjs';
import { ExtensionRegistry } from '../platform/extensions/registry.mjs';
import { assertLocalDevelopmentInvocation, decisionFromLocalDevelopmentInvocation } from './local-development-invocation.mjs';

const schema = JSON.parse(readFileSync(new URL('../../schemas/project-harness-config.schema.json', import.meta.url), 'utf8'));

const resolveConsumerPath = (base, value, label) => {
  assert(typeof value === 'string' && value.length > 0, 'PROJECT_CONFIG_PATH_REQUIRED', `${label} is required.`);
  return resolve(base, value);
};

export const validateProjectHarnessConfig = input => {
  assertJsonSchema(input, schema, { code: 'PROJECT_HARNESS_CONFIG_INVALID', label: 'Project Harness configuration' });
  assert(new Set(input.extensions.map(item => item.id)).size === input.extensions.length, 'PROJECT_CONFIG_EXTENSION_DUPLICATE', 'Project Harness configuration repeats an Extension ID.');
  assert(input.extensions.some(item => item.id === input.project.generatorExtensionId), 'PROJECT_CONFIG_GENERATOR_EXTENSION_REQUIRED', 'Descriptor generator Extension must be declared.');
  assert(input.extensions.some(item => item.id === input.binding.extensionId), 'PROJECT_CONFIG_BOUND_EXTENSION_REQUIRED', 'Bound Extension must be declared.');
  return structuredClone(input);
};

export const loadProjectHarnessConfig = async (configPathInput, { projectRoot: projectRootInput } = {}) => {
  const configPath = resolve(configPathInput ?? 'harness.json');
  const raw = await readFile(configPath, 'utf8');
  const config = validateProjectHarnessConfig(JSON.parse(raw));
  const configRoot = dirname(configPath);
  const projectRoot = projectRootInput ? resolve(projectRootInput) : configRoot;
  const workspaceRoot = resolveConsumerPath(projectRoot, config.binding.workspaceRoot, 'binding.workspaceRoot');
  const projectInput = structuredClone(config.project.input);
  if (projectInput.id !== undefined) assert(projectInput.id === config.binding.projectId, 'PROJECT_CONFIG_ID_MISMATCH', 'Project input ID differs from binding.projectId.');
  if (projectInput.workspaceRoot !== undefined) {
    const inputRoot = isAbsolute(projectInput.workspaceRoot) ? resolve(projectInput.workspaceRoot) : resolveConsumerPath(projectRoot, projectInput.workspaceRoot, 'project.input.workspaceRoot');
    assert(inputRoot === workspaceRoot, 'PROJECT_CONFIG_WORKSPACE_MISMATCH', 'Project input workspaceRoot differs from binding.workspaceRoot.');
  }
  projectInput.id = config.binding.projectId;
  projectInput.workspaceRoot = workspaceRoot;
  return {
    config,
    configPath,
    configRoot,
    projectRoot,
    configDigest: sha256(raw),
    request: {
      protocolVersion: '1.0',
      extensions: config.extensions.map(item => ({ ...item })),
      project: { generatorExtensionId: config.project.generatorExtensionId, input: projectInput },
      binding: {
        projectId: config.binding.projectId,
        profileId: config.binding.profileId,
        extensionId: config.binding.extensionId,
        workspaceRoot,
      },
    },
  };
};

export const projectInitializationPlanDigest = plan => digestJson(withoutKeys(plan, ['planDigest']));

export const createProjectInitializationPlan = async (configPath, { projectRoot, controlRoot, dataRoot, releaseIdentity, mode = 'installed' } = {}) => {
  assert(['installed', 'source-link'].includes(mode), 'PROJECT_INIT_MODE_INVALID', 'Project initialization mode must be installed or source-link.');
  const loaded = await loadProjectHarnessConfig(configPath, { projectRoot });
  const bootstrapPlan = await createBootstrapPlan(loaded.request, { controlRoot, dataRoot, releaseIdentity, developmentMode: mode === 'source-link' });
  const body = {
    protocolVersion: '1.0',
    kind: 'project-initialization-plan',
    mode,
    configPath: loaded.configPath,
    configDigest: loaded.configDigest,
    projectRoot: loaded.projectRoot,
    alias: loaded.config.binding.alias ?? loaded.config.binding.projectId,
    bootstrapPlan,
  };
  return { ...body, planDigest: projectInitializationPlanDigest(body) };
};

export const verifyProjectInitializationPlan = async plan => {
  assert(plan?.protocolVersion === '1.0' && plan.kind === 'project-initialization-plan', 'PROJECT_INIT_PLAN_INVALID', 'Project initialization plan is invalid.');
  assert(plan.planDigest === projectInitializationPlanDigest(plan), 'PROJECT_INIT_PLAN_DIGEST_MISMATCH', 'Project initialization plan digest changed.');
  const raw = await readFile(resolve(plan.configPath), 'utf8');
  assert(sha256(raw) === plan.configDigest, 'PROJECT_INIT_CONFIG_CHANGED', 'harness.json changed after the initialization plan was created.');
  return structuredClone(plan);
};

export const applyProjectInitializationPlan = async (planInput, options = {}) => {
  const plan = await verifyProjectInitializationPlan(planInput);
  const developmentInvocation = options.developmentInvocation
    ? assertLocalDevelopmentInvocation(options.developmentInvocation, { projectRoot: plan.projectRoot, configPath: plan.configPath, controlRoot: plan.bootstrapPlan.controlRoot, dataRoot: plan.bootstrapPlan.dataRoot })
    : null;
  const authorityDecision = options.authorityDecision ?? (plan.mode === 'source-link' && developmentInvocation
    ? decisionFromLocalDevelopmentInvocation(developmentInvocation, { action: 'project-init', planDigest: plan.planDigest, commandId: options.commandId, projectId: plan.bootstrapPlan.request.binding.projectId, harnessArtifactDigest: plan.bootstrapPlan.harness.artifactDigest, expectedExtensionRevision: plan.bootstrapPlan.expectedExtensionRevision, expectedProjectRevision: plan.bootstrapPlan.expectedProjectRevision })
    : null);
  const result = await applyBootstrapPlan(plan.bootstrapPlan, { ...options, authorityDecision, developmentMode: plan.mode === 'source-link' });
  const extensionRegistry = new ExtensionRegistry({ controlRoot: options.controlRoot ?? plan.bootstrapPlan.controlRoot, dataRoot: options.dataRoot ?? plan.bootstrapPlan.dataRoot, developmentMode: plan.mode === 'source-link' });
  const boundExtension = await extensionRegistry.loadOne(plan.bootstrapPlan.request.binding.extensionId);
  const workflows = (boundExtension.workflows ?? []).map(workflow => ({ id: workflow.id, version: workflow.version, artifactDigest: workflow.artifactDigest, profileId: workflow.profileId, extensionId: boundExtension.id }));
  const receiptBody = {
    protocolVersion: '1.0',
    kind: 'project-initialization-receipt',
    mode: plan.mode,
    planDigest: plan.planDigest,
    configPath: plan.configPath,
    configDigest: plan.configDigest,
    projectRoot: plan.projectRoot,
    alias: plan.alias,
    hostBinding: {
      alias: plan.alias,
      projectId: plan.bootstrapPlan.request.binding.projectId,
      profileId: plan.bootstrapPlan.request.binding.profileId,
      extensionId: plan.bootstrapPlan.request.binding.extensionId,
      workspaceRoot: plan.bootstrapPlan.request.binding.workspaceRoot,
      workflows,
    },
    bootstrapReceipt: result.receipt,
  };
  return { receipt: { ...receiptBody, receiptDigest: digestJson(receiptBody) }, reused: result.reused };
};

export const writeProjectHarnessTemplate = async (targetInput, { force = false } = {}) => {
  const target = resolve(targetInput ?? 'harness.json');
  const template = {
    $schema: 'https://agent-harness.local/schemas/project-harness-config.schema.json',
    schemaVersion: '1.0',
    kind: 'agent-harness-project',
    extensions: [
      { id: 'delivery-lifecycle-profile', version: '1.0.0', module: 'agent-harness/consumers/delivery-lifecycle' },
      { id: 'codex-runtime', version: '1.0.0', module: 'agent-harness/extensions/codex-runtime' },
    ],
    project: { generatorExtensionId: 'delivery-lifecycle-profile', input: { maxConcurrency: 'auto', gateRecipes: [] } },
    binding: { alias: 'my-project', projectId: 'my-project', profileId: 'delivery-lifecycle', extensionId: 'delivery-lifecycle-profile', workspaceRoot: '.' },
  };
  await writeFile(target, `${JSON.stringify(template, null, 2)}\n`, { encoding: 'utf8', flag: force ? 'w' : 'wx' });
  return { path: target, config: template };
};
