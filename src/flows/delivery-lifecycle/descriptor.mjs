import { isAbsolute } from 'node:path';
import { assert } from '../../common/errors.mjs';
import { AUTO_CONCURRENCY } from '../../common/concurrency.mjs';
import { validateWorkGraph } from '../../kernel/work-graph.mjs';
import { DELIVERY_STAGES } from './policy/index.mjs';

export const createDeliveryProjectDescriptor = ({
  id = 'delivery-project',
  harness,
  workspaceRoot,
  remote,
  runtimePluginId = 'codex-conversation-runtime',
  runtimePluginIds = [runtimePluginId],
  agentExecutionMode,
  runtimeExtension,
  headlessRuntimeExtension,
  runtimeConfigs: runtimeConfigOverrides = {},
  extensions = [],
  model,
  gateRecipes = [],
  maxConcurrency = AUTO_CONCURRENCY,
  actionExecution = {},
  knownFindingInventories,
  actionPaths,
  qualityVerificationOutputs = [],
  excluded = ['.git', '.agent-harness-data', 'node_modules'],
} = {}) => {
  assert(workspaceRoot && isAbsolute(workspaceRoot), 'DELIVERY_WORKSPACE_REQUIRED', 'Delivery project descriptor requires an absolute workspaceRoot.');
  assert(actionExecution && typeof actionExecution === 'object' && !Array.isArray(actionExecution), 'DELIVERY_ACTION_EXECUTION_INVALID', 'Delivery actionExecution must be an object.');
  if (runtimePluginId !== 'codex-conversation-runtime') assert(agentExecutionMode, 'HEADLESS_EXECUTION_MODE_EXPLICIT_REQUIRED', 'Selecting a non-default Runtime requires an explicit agentExecutionMode; headless execution is never inferred from a Runtime ID.');
  const resolvedAgentExecutionMode = agentExecutionMode ?? 'conversation-visible';
  const workspace = { root: workspaceRoot, rootSelector: 'git-worktree', excluded };
  if (remote) workspace.remote = remote;
  const runtimePlugins = [...new Set(runtimePluginIds)];
  assert(runtimePlugins.includes(runtimePluginId), 'PROJECT_RUNTIME_ALLOWLIST_INVALID', 'runtimePluginIds must include the default Runtime.');
  for (const [action, value] of Object.entries(actionExecution)) assert(runtimePlugins.includes(value?.runtimePluginId), 'ACTION_RUNTIME_EXPLICIT_ALLOWLIST_REQUIRED', `Action ${action} Runtime must be explicitly included in runtimePluginIds.`);
  const selectedRuntimeExtensions = [];
  if (runtimePlugins.includes('codex-conversation-runtime')) selectedRuntimeExtensions.push(runtimeExtension === undefined ? { id: 'codex-runtime', version: '1.0.0' } : runtimeExtension);
  if (runtimePlugins.some(rId => ['codex-cli-runtime', 'codex-isolated-runtime'].includes(rId))) selectedRuntimeExtensions.push(headlessRuntimeExtension === undefined ? { id: 'codex-headless-runtime', version: '1.0.0' } : headlessRuntimeExtension);
  if (!runtimePlugins.some(rId => ['codex-conversation-runtime', 'codex-cli-runtime', 'codex-isolated-runtime'].includes(rId)) && runtimeExtension) selectedRuntimeExtensions.push(runtimeExtension);
  const runtimeConfigs = Object.fromEntries(runtimePlugins.map(rId => {
    const processBacked = ['codex-cli-runtime', 'codex-isolated-runtime'].includes(rId);
    const config = { ...(processBacked ? { sandbox: 'workspace-write', ephemeral: true } : {}), ...(runtimeConfigOverrides[rId] ?? {}) };
    if (model) config.model = model;
    return [rId, config];
  }));
  return {
    id,
    ...(harness ? { harness: structuredClone(harness) } : {}),
    workspace,
    profiles: ['delivery-lifecycle'],
    extensions: [
      { id: 'delivery-lifecycle-profile', version: '1.0.0' },
      ...selectedRuntimeExtensions.filter(Boolean).map(value => structuredClone(value)),
      ...structuredClone(extensions),
    ],
    policy: {
      agentExecutionMode: resolvedAgentExecutionMode,
      defaultRuntimePlugin: runtimePluginId,
      runtimePlugins,
      promptCodecPlugin: 'reference-agent-prompt-codec',
      runtimeConfigs,
      profileConfigs: { 'delivery-lifecycle': {} },
      ...(actionPaths ? { actionPaths: structuredClone(actionPaths) } : {}),
      qualityVerificationOutputs: structuredClone(qualityVerificationOutputs),
      ...(Object.keys(actionExecution).length ? { actionExecution: structuredClone(actionExecution) } : {}),
      ...(knownFindingInventories && Object.keys(knownFindingInventories).length ? { knownFindingInventories: structuredClone(knownFindingInventories) } : {}),
      recovery: { automaticLineageResolution: true, automaticOrdinaryResume: true, automaticVerifiedHardRecovery: true, preserveSupersededRuns: true },
      maxConcurrency,
    },
    gateRecipes: structuredClone(gateRecipes),
    artifactProviders: [],
  };
};

export const compileDeliveryFeatureGraph = ({ requirement, features = [] } = {}) => {
  assert(requirement?.id && requirement?.acceptance?.length, 'CANONICAL_REQUIREMENT_REQUIRED', 'Delivery graph requires exactly one canonical requirement.');
  const canonicalId = `requirement/${requirement.id}`;
  const canonical = {
    id: canonicalId,
    executionClass: 'agent-reasoning',
    kind: 'canonical-requirement',
    ownerRole: 'planner',
    logicalRoot: `requirement:${requirement.id}`,
    laneId: 'planning',
    acceptance: requirement.acceptance,
    steps: requirement.steps ?? [],
    dependsOn: requirement.dependsOn ?? [],
    allowedPaths: requirement.allowedPaths ?? ['docs/requirements.md'],
    forbiddenPaths: requirement.forbiddenPaths ?? [],
    metadata: { ...(requirement.metadata ?? {}), stage: 'canonical-requirement', canonical: true },
  };
  const compiled = features.map(feature => {
    assert(DELIVERY_STAGES.includes(feature.stage), 'DELIVERY_STAGE_INVALID', `Unknown delivery stage: ${feature.stage}`);
    assert(DELIVERY_STAGES.indexOf(feature.stage) > DELIVERY_STAGES.indexOf('canonical-requirement'), 'DELIVERY_STAGE_BEFORE_CANONICAL', 'Compiled delivery Features must come after the canonical requirement.');
    const dependencies = feature.dependsOn?.length ? feature.dependsOn : [canonicalId];
    return { ...structuredClone(feature), dependsOn: dependencies, metadata: { ...(feature.metadata ?? {}), stage: feature.stage } };
  });
  return validateWorkGraph([canonical, ...compiled]);
};
