import { isAbsolute } from 'node:path';
import { assert } from '../../../../common/errors.mjs';
import { validateWorkGraph } from '../../../../kernel/work-graph.mjs';

export const COLLECTION_FINAL_GATE_IDS = Object.freeze([
  'collection-typecheck',
  'collection-test',
  'collection-web-build',
  'collection-mobile-check',
  'collection-desktop-check',
  'collection-registry-check',
  'collection-packs-check',
  'collection-ledgers-check',
  'collection-engine-boundary',
  'collection-release-contract',
  'collection-cleanroom',
]);

const pnpmGate = (id, script, timeoutMs = 900000) => ({ id, executionClass: 'deterministic-process', scope: 'final', required: true, forceFresh: true, command: ['pnpm', script], cwd: '.', timeoutMs });

export const createTabletopCollectionProjectDescriptor = ({
  id = 'tabletop-collection',
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
  maxConcurrency = 10,
  maxLogicalGames = 10,
  batches = [],
} = {}) => {
  assert(workspaceRoot && isAbsolute(workspaceRoot), 'COLLECTION_WORKSPACE_REQUIRED', 'Collection descriptor requires an absolute workspaceRoot.');
  if (runtimePluginId !== 'codex-conversation-runtime') assert(agentExecutionMode, 'HEADLESS_EXECUTION_MODE_EXPLICIT_REQUIRED', 'Selecting a non-default Runtime requires an explicit agentExecutionMode; headless execution is never inferred from a Runtime ID.');
  const resolvedAgentExecutionMode = agentExecutionMode ?? 'conversation-visible';
  const workspace = { root: workspaceRoot, rootSelector: 'git-worktree', excluded: ['.git', 'node_modules', 'dist', 'build', 'coverage', 'runs'] };
  if (remote) workspace.remote = remote;
  const runtimePlugins = [...new Set(runtimePluginIds)];
  assert(runtimePlugins.includes(runtimePluginId), 'PROJECT_RUNTIME_ALLOWLIST_INVALID', 'runtimePluginIds must include the default Runtime.');
  const selectedRuntimeExtensions = [];
  if (runtimePlugins.includes('codex-conversation-runtime')) selectedRuntimeExtensions.push(runtimeExtension === undefined ? { id: 'codex-runtime', version: '1.0.0' } : runtimeExtension);
  if (runtimePlugins.some(id => ['codex-cli-runtime', 'codex-isolated-runtime'].includes(id))) selectedRuntimeExtensions.push(headlessRuntimeExtension === undefined ? { id: 'codex-headless-runtime', version: '1.0.0' } : headlessRuntimeExtension);
  if (!runtimePlugins.some(id => ['codex-conversation-runtime', 'codex-cli-runtime', 'codex-isolated-runtime'].includes(id)) && runtimeExtension) selectedRuntimeExtensions.push(runtimeExtension);
  const runtimeConfigs = Object.fromEntries(runtimePlugins.map(id => {
    const processBacked = ['codex-cli-runtime', 'codex-isolated-runtime'].includes(id);
    const config = { ...(processBacked ? { sandbox: 'workspace-write', ephemeral: true } : {}), ...(runtimeConfigOverrides[id] ?? {}) };
    if (model) config.model = model;
    return [id, config];
  }));
  return {
    id,
    ...(harness ? { harness: structuredClone(harness) } : {}),
    workspace,
    profiles: ['collection-batch'],
    extensions: [
      { id: 'tabletop-collection-profile', version: '1.0.0' },
      ...selectedRuntimeExtensions.filter(Boolean).map(value => structuredClone(value)),
      ...structuredClone(extensions),
    ],
    policy: {
      agentExecutionMode: resolvedAgentExecutionMode,
      defaultRuntimePlugin: runtimePluginId,
      runtimePlugins,
      promptCodecPlugin: 'reference-agent-prompt-codec',
      runtimeConfigs,
      recovery: { automaticLineageResolution: true, automaticOrdinaryResume: true, automaticVerifiedHardRecovery: true, preserveSupersededRuns: true },
      maxConcurrency,
      maxLogicalGames,
      collectionBatches: structuredClone(batches),
      profileConfigs: { 'collection-batch': { maxLogicalGames } },
    },
    gateRecipes: [
      pnpmGate('collection-typecheck', 'typecheck'),
      pnpmGate('collection-test', 'test'),
      pnpmGate('collection-web-build', 'build:web'),
      pnpmGate('collection-mobile-check', 'check:mobile'),
      pnpmGate('collection-desktop-check', 'check:desktop'),
      pnpmGate('collection-registry-check', 'check:game-registry'),
      pnpmGate('collection-packs-check', 'check:game-packs'),
      pnpmGate('collection-ledgers-check', 'check:acceptance-ledgers'),
      pnpmGate('collection-engine-boundary', 'check:engine-boundary'),
      pnpmGate('collection-release-contract', 'check:release-contract'),
      pnpmGate('collection-cleanroom', 'cleanroom'),
    ],
    artifactProviders: [],
  };
};

const normalizeGameFeature = (batchId, game, feature, defaultRuleStatus) => {
  assert(feature?.id, 'COLLECTION_FEATURE_ID_REQUIRED', `Game ${game.id} contains a Feature without an ID.`);
  const id = feature.id.includes('/') ? feature.id : `${game.id}/${feature.id}`;
  return {
    ...structuredClone(feature),
    id,
    logicalRoot: feature.logicalRoot ?? `game:${game.id}:${feature.id}`,
    laneId: feature.laneId ?? game.id,
    dependsOn: feature.dependsOn ?? [],
    metadata: {
      ...(feature.metadata ?? {}),
      batchId,
      gameId: game.id,
      ruleStatus: feature.ruleStatus ?? game.ruleStatus ?? defaultRuleStatus,
    },
  };
};

export const compileTabletopCollectionFeatureGraph = ({ batchId, games, sharedCapabilities = [], defaultRuleStatus = 'rule-ready', maxLogicalGames = 10 } = {}) => {
  assert(batchId, 'COLLECTION_BATCH_REQUIRED', 'Collection graph requires a batchId.');
  assert(Array.isArray(games) && games.length > 0, 'COLLECTION_GAMES_REQUIRED', 'Collection graph requires at least one game.');
  assert(new Set(games.map(game => game.id)).size === games.length, 'COLLECTION_GAME_DUPLICATE', 'Collection game IDs must be unique.');
  assert(games.length <= maxLogicalGames, 'LOGICAL_GAME_LIMIT_EXCEEDED', `Collection graph exceeds ${maxLogicalGames} logical games.`);
  const gameFeatures = games.flatMap(game => {
    assert(game.id && Array.isArray(game.features) && game.features.length > 0, 'COLLECTION_GAME_FEATURES_REQUIRED', 'Every Collection game requires an ID and at least one Feature.');
    return game.features.map(feature => normalizeGameFeature(batchId, game, feature, defaultRuleStatus));
  });
  const shared = sharedCapabilities.map(capability => {
    assert(capability.key && capability.feature?.id, 'CAPABILITY_OWNER_REQUIRED', 'Shared capability requires a key and owner Feature.');
    return {
      ...structuredClone(capability.feature),
      logicalRoot: capability.feature.logicalRoot ?? `capability:${capability.key}`,
      laneId: capability.feature.laneId ?? '_shared',
      dependsOn: capability.feature.dependsOn ?? [],
      metadata: { ...(capability.feature.metadata ?? {}), batchId, gameId: null, capabilityKey: capability.key, capabilityOwner: true, ruleStatus: capability.feature.ruleStatus ?? defaultRuleStatus },
    };
  });
  const owners = new Map(sharedCapabilities.map((capability, index) => [capability.key, shared[index].id]));
  for (const feature of gameFeatures) {
    const uses = feature.metadata.capabilityUses ?? [];
    for (const key of uses) {
      const owner = owners.get(key);
      assert(owner, 'CAPABILITY_OWNER_UNKNOWN', `Feature ${feature.id} uses unknown capability ${key}.`);
      feature.dependsOn = [...new Set([...feature.dependsOn, owner])];
      feature.metadata = { ...feature.metadata, capabilityUses: uses };
    }
  }
  return validateWorkGraph([...shared, ...gameFeatures]);
};
