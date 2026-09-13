import { isAbsolute } from 'node:path';
import { assert } from '../errors.mjs';
import { validateWorkGraph } from '../kernel/work-graph.mjs';
import { collectionBatchProfile } from '../profiles/collection-batch.mjs';
import { defineExtensionPack } from '../extensions/contract.mjs';
import { defineCommandManifest } from '../extensions/command-contract.mjs';

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

export const tabletopCollectionCommandManifest = defineCommandManifest({
  protocolVersion: '1.0',
  id: 'batch-production-commands',
  profileId: 'collection-batch',
  actions: {
    full: { targetKind: 'batch-id', presets: { default: { scope: 'rule-readiness..release-receipt', stateChanging: true } } },
    rules: { targetKind: 'batch-id', presets: { default: { scope: 'rule-readiness', stateChanging: true } } },
    launch: { targetKind: 'batch-id', presets: { default: { scope: 'batch-launch', stateChanging: true } } },
    produce: { targetKind: 'batch-id', presets: { default: { scope: 'round-production', stateChanging: true } } },
    quality: {
      aliases: ['qa'], targetKind: 'batch-id', defaultPreset: 'all', presets: {
        all: { scope: 'game-harness-acceptance', stateChanging: true },
        game: { scope: 'single-game-harness-acceptance', stateChanging: true, argumentPrefix: 'game:' },
      },
    },
    review: {
      targetKind: 'batch-id', defaultPreset: 'all', presets: {
        all: { scope: 'independent-release-review', stateChanging: true, sourcePolicy: 'read-only' },
        game: { scope: 'single-game-release-review', stateChanging: true, sourcePolicy: 'read-only', argumentPrefix: 'game:' },
      },
    },
    accept: {
      targetKind: 'batch-id', defaultPreset: 'all', presets: {
        all: { scope: 'user-acceptance', stateChanging: true },
        game: { scope: 'single-game-user-acceptance', stateChanging: true, argumentPrefix: 'game:' },
      },
    },
    close: { targetKind: 'batch-id', presets: { default: { scope: 'batch-close..release-receipt', stateChanging: true } } },
    status: { targetKind: 'batch-id-or-run-id', presets: { default: { scope: 'status', stateChanging: false } } },
    resume: { targetKind: 'batch-id-or-run-id', presets: { default: { scope: 'ordinary-resume', stateChanging: true } } },
    recover: {
      targetKind: 'run-id', defaultPreset: 'assess', presets: {
        assess: { scope: 'recovery-assessment', stateChanging: false },
        hard: { scope: 'hard-recovery', stateChanging: true, approval: 'live-hard-recovery' },
      },
    },
  },
});

const pnpmGate = (id, script, timeoutMs = 900000) => ({ id, scope: 'final', required: true, forceFresh: true, command: ['pnpm', script], cwd: '.', timeoutMs });

export const createTabletopCollectionProjectDescriptor = ({
  id = 'tabletop-collection',
  harness,
  workspaceRoot,
  remote,
  runtimePluginId = 'codex-isolated-runtime',
  runtimeExtension,
  extensions = [],
  model,
  maxConcurrency = 10,
  maxLogicalGames = 10,
} = {}) => {
  assert(workspaceRoot && isAbsolute(workspaceRoot), 'COLLECTION_WORKSPACE_REQUIRED', 'Collection descriptor requires an absolute workspaceRoot.');
  const workspace = { root: workspaceRoot, excluded: ['.git', 'node_modules', 'dist', 'build', 'coverage', 'runs'] };
  if (remote) workspace.remote = remote;
  const runtimeConfig = { sandbox: 'workspace-write', ephemeral: true, approveForMe: true };
  if (model) runtimeConfig.model = model;
  const selectedRuntimeExtension = runtimeExtension === undefined
    ? (runtimePluginId === 'codex-isolated-runtime' ? { id: 'codex-runtime', version: '1.0.0' } : null)
    : runtimeExtension;
  return {
    id,
    ...(harness ? { harness: structuredClone(harness) } : {}),
    workspace,
    profiles: ['collection-batch'],
    extensions: [
      { id: 'tabletop-collection-profile', version: '1.0.0' },
      ...(selectedRuntimeExtension ? [structuredClone(selectedRuntimeExtension)] : []),
      ...structuredClone(extensions),
    ],
    policy: {
      defaultRuntimePlugin: runtimePluginId,
      runtimePlugins: [runtimePluginId],
      runtimeConfigs: { [runtimePluginId]: runtimeConfig },
      maxConcurrency,
      maxLogicalGames,
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
      metadata: { ...(capability.feature.metadata ?? {}), batchId, capabilityKey: capability.key, capabilityOwner: true, ruleStatus: capability.feature.ruleStatus ?? defaultRuleStatus },
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

export const extensionPack = defineExtensionPack({
  id: 'tabletop-collection-profile',
  version: '1.0.0',
  profiles: [collectionBatchProfile],
  commandManifest: tabletopCollectionCommandManifest,
  operations: {
    createProjectDescriptor: createTabletopCollectionProjectDescriptor,
    compileFeatureGraph: compileTabletopCollectionFeatureGraph,
  },
});

export default extensionPack;
