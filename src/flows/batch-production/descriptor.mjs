import { isAbsolute } from 'node:path';
import { assert } from '../../common/errors.mjs';
import { validateWorkGraph } from '../../kernel/work-graph.mjs';

export const createBatchProductionProjectDescriptor = ({
  id = 'batch-production-project',
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
  maxConcurrency = 10,
  maxLogicalItems = 10,
  batches = [],
  itemKey = 'itemId',
  itemPaths,
  excluded = ['.git', '.agent-harness-data', 'node_modules'],
} = {}) => {
  assert(workspaceRoot && isAbsolute(workspaceRoot), 'BATCH_WORKSPACE_REQUIRED', 'Batch project descriptor requires an absolute workspaceRoot.');
  if (runtimePluginId !== 'codex-conversation-runtime') assert(agentExecutionMode, 'HEADLESS_EXECUTION_MODE_EXPLICIT_REQUIRED', 'Selecting a non-default Runtime requires an explicit agentExecutionMode; headless execution is never inferred from a Runtime ID.');
  const resolvedAgentExecutionMode = agentExecutionMode ?? 'conversation-visible';
  const workspace = { root: workspaceRoot, rootSelector: 'git-worktree', excluded };
  if (remote) workspace.remote = remote;
  const runtimePlugins = [...new Set(runtimePluginIds)];
  assert(runtimePlugins.includes(runtimePluginId), 'PROJECT_RUNTIME_ALLOWLIST_INVALID', 'runtimePluginIds must include the default Runtime.');
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
    profiles: ['batch-production'],
    extensions: [
      { id: 'batch-production-profile', version: '1.0.0' },
      ...selectedRuntimeExtensions.filter(Boolean).map(value => structuredClone(value)),
      ...structuredClone(extensions),
    ],
    policy: {
      agentExecutionMode: resolvedAgentExecutionMode,
      defaultRuntimePlugin: runtimePluginId,
      runtimePlugins,
      promptCodecPlugin: 'reference-agent-prompt-codec',
      runtimeConfigs,
      maxConcurrency,
      maxLogicalItems,
      batches: structuredClone(batches),
      itemKey,
      ...(itemPaths ? { itemPaths } : {}),
      profileConfigs: {
        'batch-production': { maxLogicalItems },
      },
    },
    gateRecipes: structuredClone(gateRecipes),
    artifactProviders: [],
  };
};

const normalizeBatchItemFeature = (batchId, item, feature, defaultRuleStatus, itemKey = 'itemId') => {
  assert(feature?.id, 'BATCH_FEATURE_ID_REQUIRED', `Item ${item.id} contains a Feature without an ID.`);
  const id = feature.id.includes('/') ? feature.id : `${item.id}/${feature.id}`;
  return {
    id,
    executionClass: 'agent-reasoning',
    kind: feature.kind ?? 'batch-item',
    ownerRole: feature.ownerRole ?? 'operator',
    logicalRoot: feature.logicalRoot ?? `item:${item.id}:${feature.id}`,
    laneId: feature.laneId ?? item.id,
    acceptance: structuredClone(feature.acceptance ?? [`Complete ${feature.id} for item ${item.id}.`]),
    steps: structuredClone(feature.steps ?? [{ id: 'execute', title: `Execute ${feature.id}.` }]),
    dependsOn: [...(feature.dependsOn ?? [])],
    allowedPaths: [...(feature.allowedPaths ?? [`items/${item.id}`])],
    forbiddenPaths: [...(feature.forbiddenPaths ?? ['.git', '.agent-harness-data'])],
    metadata: {
      ...(feature.metadata ?? {}),
      batchId,
      [itemKey]: item.id,
      itemId: item.id,
      ruleStatus: feature.ruleStatus ?? item.ruleStatus ?? defaultRuleStatus,
    },
  };
};

export const compileBatchProductionFeatureGraph = ({ batchId, items = [], sharedCapabilities = [], defaultRuleStatus = 'rule-ready', maxLogicalItems = 10, itemKey = 'itemId' } = {}) => {
  assert(Array.isArray(items) && items.length > 0, 'BATCH_ITEMS_REQUIRED', 'Batch graph requires at least one item.');
  assert(new Set(items.map(item => item.id)).size === items.length, 'BATCH_ITEM_DUPLICATE', 'Batch item IDs must be unique.');
  assert(items.length <= maxLogicalItems, 'LOGICAL_ITEM_LIMIT_EXCEEDED', `Batch graph exceeds ${maxLogicalItems} logical items.`);
  const itemFeatures = items.flatMap(item => {
    assert(item.id && Array.isArray(item.features) && item.features.length > 0, 'BATCH_ITEM_FEATURES_REQUIRED', 'Every batch item requires an ID and at least one Feature.');
    return item.features.map(feature => normalizeBatchItemFeature(batchId, item, feature, defaultRuleStatus, itemKey));
  });
  const capabilityFeatures = sharedCapabilities.map(capability => ({
    id: capability.feature.id,
    executionClass: 'agent-reasoning',
    kind: capability.feature.kind ?? 'shared-capability',
    ownerRole: capability.feature.ownerRole ?? 'operator',
    logicalRoot: capability.feature.logicalRoot ?? `shared:${capability.key}`,
    laneId: capability.feature.laneId ?? 'shared',
    acceptance: structuredClone(capability.feature.acceptance ?? [`Maintain shared capability ${capability.key}.`]),
    steps: structuredClone(capability.feature.steps ?? [{ id: 'execute', title: `Execute shared capability ${capability.key}.` }]),
    dependsOn: [...(capability.feature.dependsOn ?? [])],
    allowedPaths: [...(capability.feature.allowedPaths ?? [`packages/shared/${capability.key}`])],
    forbiddenPaths: [...(capability.feature.forbiddenPaths ?? ['.git', '.agent-harness-data'])],
    metadata: {
      ...(capability.feature.metadata ?? {}),
      batchId,
      itemId: null,
      capabilityKey: capability.key,
      capabilityOwner: true,
      ruleStatus: capability.feature.ruleStatus ?? defaultRuleStatus,
    },
  }));
  for (const feature of itemFeatures) {
    const consumed = feature.metadata.capabilityUses ?? [];
    for (const key of consumed) {
      const owner = capabilityFeatures.find(f => f.metadata.capabilityKey === key);
      assert(owner, 'SHARED_CAPABILITY_NOT_FOUND', `Item feature ${feature.id} depends on undeclared capability ${key}.`);
      if (!feature.dependsOn.includes(owner.id)) feature.dependsOn.push(owner.id);
    }
  }
  return validateWorkGraph([...capabilityFeatures, ...itemFeatures]);
};
