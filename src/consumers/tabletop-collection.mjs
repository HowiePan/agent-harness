import { isAbsolute } from 'node:path';
import { assert } from '../errors.mjs';
import { validateWorkGraph } from '../kernel/work-graph.mjs';
import { compileWorkflowFeatures, defineWorkflowDefinition } from '../workflows/definition.mjs';
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
  workflowId: 'collection-batch-production',
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
        hard: { scope: 'hard-recovery', stateChanging: true, replayability: 'authority-only', effectClasses: ['authority-epoch-transition', 'transport-invalidation', 'completion-revalidation', 'rollback-snapshot'] },
      },
    },
  },
});

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

const collectionNode = (id, action, dependsOn = [], options = {}) => ({ id, template: 'collection-stage', action, forEach: 'item', dependsOn, ...options });
export const collectionWorkflowDefinition = defineWorkflowDefinition({
  id: 'collection-batch-production', version: '1.0.0', profileId: 'collection-batch',
  routes: {
    full: [collectionNode('rules', 'rules'), collectionNode('produce', 'produce', ['rules']), collectionNode('quality', 'quality', ['produce'], { qualityReview: true }), collectionNode('review', 'review', ['quality'], { readOnly: true }), collectionNode('accept', 'accept', ['review'], { readOnly: true })],
    rules: [collectionNode('rules', 'rules')], launch: [collectionNode('launch', 'launch', [], { readOnly: true })],
    produce: [collectionNode('produce', 'produce')], quality: [collectionNode('quality', 'quality', [], { qualityReview: true })],
    review: [collectionNode('review', 'review', [], { readOnly: true })], accept: [collectionNode('accept', 'accept', [], { readOnly: true })],
    close: [collectionNode('close', 'close', [], { readOnly: true })],
  },
});

export const createTabletopCollectionLifecyclePlan = ({ intent, project, runId, sourceDigest }) => {
  const finalGateIds = (project.gateRecipes ?? []).filter(recipe => recipe.scope === 'final' && recipe.required !== false).map(recipe => recipe.id);
  const gateIds = ['full', 'quality', 'close'].includes(intent.action) ? finalGateIds : [];
  const quality = intent.action === 'quality';
  const selector = intent.selector ?? null;
  const batch = (project.policy?.collectionBatches ?? []).find(item => item.id === intent.target);
  assert(batch && Array.isArray(batch.gameIds) && batch.gameIds.length > 0, 'COLLECTION_BATCH_DESCRIPTOR_REQUIRED', `Project Descriptor must declare non-empty gameIds for batch ${intent.target}.`);
  assert(new Set(batch.gameIds).size === batch.gameIds.length, 'COLLECTION_GAME_DUPLICATE', `Batch ${intent.target} contains duplicate game IDs.`);
  assert(batch.gameIds.length <= Number(project.policy?.maxLogicalGames ?? 10), 'LOGICAL_GAME_LIMIT_EXCEEDED', `Batch ${intent.target} exceeds the configured logical game limit.`);
  if (selector) assert(batch.gameIds.includes(selector), 'COLLECTION_GAME_NOT_IN_BATCH', `Game ${selector} is not declared in batch ${intent.target}.`);
  const gameIds = selector ? [selector] : batch.gameIds;
  const profileConfig = {
    ...(project.policy?.profileConfigs?.['collection-batch'] ?? {}),
    activeBatch: intent.target,
    maxLogicalGames: Number(project.policy?.maxLogicalGames ?? 10),
    requiredFinalGates: gateIds,
    requireRuleReady: !['launch'].includes(intent.action),
    requireHarnessAcceptance: intent.action === 'full',
    requireIndependentReview: ['full', 'review'].includes(intent.action),
    requireUserGameAcceptance: ['full', 'accept'].includes(intent.action),
    requireBatchCloseDecision: ['full', 'close'].includes(intent.action),
    requireBatchLaunchDecision: ['full', 'produce'].includes(intent.action),
    requireFinalQualityReview: ['full', 'quality'].includes(intent.action),
  };
  const makeFeature = ({ action, gameId, dependsOn = [], readOnly = false, qualityReview = false }) => ({
    id: `${action}/${intent.target}/${gameId}`,
    executionClass: 'agent-reasoning',
    kind: action,
    ownerRole: qualityReview || action === 'review' ? 'reviewer' : action === 'accept' ? 'user-acceptance' : 'operator',
    logicalRoot: `${action}:${intent.target}:${gameId}`,
    laneId: gameId,
    acceptance: qualityReview
      ? [`Perform a complete read-only quality review for ${gameId} in batch ${intent.target}.`, 'Cite non-empty evidence for every P0-P3 finding and return an exact structured result.']
      : [`Complete ${action} for ${gameId} in batch ${intent.target}.`, 'Return structured evidence and an exact changedFiles list.'],
    steps: qualityReview ? [{ id: 'review', title: `Review ${gameId} without workspace writes.` }, { id: 'report', title: 'Report all P0-P3 findings.' }] : [{ id: 'execute', title: `Execute ${action} for ${gameId}.` }],
    dependsOn,
    allowedPaths: readOnly || qualityReview ? [] : [`games/presets/${gameId}`, 'packages', 'apps', 'docs'],
    forbiddenPaths: ['.git', '.agent-harness-data', 'runs', 'F:/agent-harness'],
    conflictKeys: [`game:${gameId}`, `${action}:${intent.target}:${gameId}`],
    gatePlan: gateIds,
    metadata: {
      scope: intent.scope,
      sourcePolicy: qualityReview || readOnly ? 'read-only' : 'write',
      stage: action,
      batchId: intent.target,
      gameId,
      ruleStatus: batch.ruleStatus ?? 'rule-ready',
      ...(qualityReview ? { qualityReview: true, qualityFindingPolicy: 'repair-and-rereview', qualityRoot: `collection:${intent.target}:${gameId}`, reviewRound: 1, reviewSourceDigest: sourceDigest, qualityContext: { batchId: intent.target, gameId, ruleStatus: batch.ruleStatus ?? 'rule-ready' } } : {}),
    },
  });
  const features = compileWorkflowFeatures({ definition: collectionWorkflowDefinition, routeId: intent.action,
    templates: { 'collection-stage': ({ node, item, dependsOn }) => makeFeature({ action: node.action, gameId: item, dependsOn,
      readOnly: node.readOnly || intent.sourcePolicy === 'read-only', qualityReview: Boolean(node.qualityReview) }) },
    context: { intent, sourceDigest }, items: gameIds });
  return {
    run: { runId, profileId: 'collection-batch', profileConfig, features, runtimePluginId: project.policy?.defaultRuntimePlugin, metadata: { workflow: { id: collectionWorkflowDefinition.id, version: collectionWorkflowDefinition.version, artifactDigest: collectionWorkflowDefinition.artifactDigest } } },
    stopCondition: { type: intent.action === 'full' ? 'collection-full-complete' : 'collection-action-complete', action: intent.action, requiresFeatureCompletion: true, requiresAllFindingsResolved: ['full', 'quality'].includes(intent.action), requiredFinalGates: gateIds },
    protectedOperations: ['publication', 'commit', 'push', 'legacy-destruction', 'privilege-expansion', 'external-cutover', 'irreversible-migration'],
  };
};

export const extensionPack = defineExtensionPack({
  id: 'tabletop-collection-profile',
  version: '1.0.0',
  profiles: [collectionBatchProfile],
  workflows: [collectionWorkflowDefinition],
  commandManifest: tabletopCollectionCommandManifest,
  operationManifest: {
    createProjectDescriptor: { executionClass: 'pure-planner' },
    compileFeatureGraph: { executionClass: 'pure-planner' },
    createLifecyclePlan: { executionClass: 'pure-planner' },
  },
  operations: {
    createProjectDescriptor: createTabletopCollectionProjectDescriptor,
    compileFeatureGraph: compileTabletopCollectionFeatureGraph,
    createLifecyclePlan: createTabletopCollectionLifecyclePlan,
  },
});

export default extensionPack;
