import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CARDWORLD_FINAL_GATE_IDS,
  COLLECTION_FINAL_GATE_IDS,
  cardWorldCommandManifest,
  compileCardWorldFeatureGraph,
  compileTabletopCollectionFeatureGraph,
  createCardWorldLifecyclePlan,
  createCardWorldProjectDescriptor,
  createTabletopCollectionProjectDescriptor,
  tabletopCollectionCommandManifest,
} from '../src/flows/index.mjs';
import { resolveLifecycleExecutionPolicy } from '../src/platform/plugins/runtime/execution-policy.mjs';
import { sealKnownFindingInventory } from '../src/platform/execution/known-finding-inventory.mjs';

const knownFindingInventory = sealKnownFindingInventory({ projectId: 'cardworld-engine', target: 'V-next', declaration: { version: '1.0', sources: [{ path: 'docs/version.md', sha256: 'b'.repeat(64) }], findings: [] }, snapshot: { digest: 'a'.repeat(64), files: [{ path: 'docs/version.md', sha256: 'b'.repeat(64) }] } });

test('CardWorld consumer compiles one canonical requirement and project-owned delivery Features', () => {
  const descriptor = createCardWorldProjectDescriptor({ workspaceRoot: process.cwd(), remote: 'https://github.com/HowiePan/CardWorld.git' });
  assert.deepEqual(descriptor.gateRecipes.map(gate => gate.id), CARDWORLD_FINAL_GATE_IDS);
  assert(descriptor.workspace.excluded.includes('.cardworld-local'));
  assert.equal(descriptor.workspace.rootSelector, 'git-worktree');
  assert.deepEqual(descriptor.gateRecipes.slice(1).map(gate => gate.command.slice(3, 6)), [
    ['scripts/cardworld.ps1', '-Task', 'engine-fmt'],
    ['scripts/cardworld.ps1', '-Task', 'engine-test'],
    ['scripts/cardworld.ps1', '-Task', 'engine-clippy'],
    ['scripts/cardworld.ps1', '-Task', 'engine-wasm-release-check'],
  ]);
  assert.equal(descriptor.gateRecipes.find(gate => gate.id === 'rust-tests-all-targets').command.at(-1), '--all-targets');
  assert.deepEqual(descriptor.extensions.map(extension => extension.id), ['cardworld-engine-profile', 'codex-runtime']);
  assert.equal(descriptor.policy.agentExecutionMode, 'conversation-visible');
  assert.equal(descriptor.policy.defaultRuntimePlugin, 'codex-conversation-runtime');
  assert.equal(descriptor.policy.promptCodecPlugin, 'reference-agent-prompt-codec');
  assert.equal(descriptor.policy.maxConcurrency, 'auto');
  assert.deepEqual(descriptor.policy.runtimeConfigs['codex-conversation-runtime'], {});
  const scoped = createCardWorldProjectDescriptor({ workspaceRoot: process.cwd(), runtimePluginIds: ['codex-conversation-runtime', 'codex-cli-runtime'], actionExecution: { quality: { agentExecutionMode: 'headless', runtimePluginId: 'codex-cli-runtime' } } });
  assert.deepEqual(scoped.policy.runtimePlugins, ['codex-conversation-runtime', 'codex-cli-runtime']);
  assert.deepEqual(scoped.extensions.map(extension => extension.id), ['cardworld-engine-profile', 'codex-runtime', 'codex-headless-runtime']);
  assert.deepEqual(scoped.policy.actionExecution.quality, { agentExecutionMode: 'headless', runtimePluginId: 'codex-cli-runtime' });
  assert.deepEqual(scoped.policy.runtimeConfigs['codex-cli-runtime'], { sandbox: 'workspace-write', ephemeral: true });
  const graph = compileCardWorldFeatureGraph({
    requirement: { id: 'v-next', acceptance: ['requirement is singular and approved'] },
    features: [
      { id: 'plan', executionClass: 'agent-reasoning', stage: 'version-planning', acceptance: ['plan accepted'], allowedPaths: ['docs/versions'] },
      { id: 'implementation/a', executionClass: 'agent-reasoning', stage: 'implementation', acceptance: ['tests pass'], allowedPaths: ['card_world_engine/src/a.rs'], dependsOn: ['plan'] },
      { id: 'implementation/b', executionClass: 'agent-reasoning', stage: 'implementation', acceptance: ['tests pass'], allowedPaths: ['card_world_engine/src/b.rs'], dependsOn: ['plan'] },
    ],
  });
  assert.equal(graph.filter(feature => feature.metadata.canonical).length, 1);
  assert.deepEqual(graph.find(feature => feature.id === 'plan').dependsOn, ['requirement/v-next']);
});

test('CardWorld full lifecycle keeps every mutable stage before the final quality review', () => {
  const project = createCardWorldProjectDescriptor({ workspaceRoot: process.cwd() });
  project.gateRecipes = [];
  const plan = createCardWorldLifecyclePlan({
    intent: { action: 'full', target: 'V-next', scope: 'requirement-intake..delivery-receipt', knownFindingInventory },
    project,
    runId: 'full-v-next',
    sourceDigest: 'a'.repeat(64),
  });
  assert.deepEqual(plan.run.features.map(feature => feature.metadata.stage), [
    'requirement-intake', 'canonical-requirement', 'version-planning', 'implementation', 'scope-resolution', 'docs-closeout', 'quality', 'user-code-review', 'delivery-receipt',
  ]);
  const quality = plan.run.features.find(feature => feature.metadata.stage === 'quality');
  assert.deepEqual(quality.dependsOn, ['docs/V-next']);
  assert.deepEqual(quality.allowedPaths, []);
});

test('CardWorld action plans use action-specific stages, paths, stop conditions, and delivery verification', () => {
  const project = createCardWorldProjectDescriptor({ workspaceRoot: process.cwd() });
  project.gateRecipes = [];
  const expected = new Map([
    ['requirements', ['requirement-intake', 'canonical-requirement', 'version-planning']],
    ['plan', ['version-planning']],
    ['implement', ['implementation']],
    ['scope', ['scope-resolution']],
    ['quality', ['quality']],
    ['docs', ['docs-closeout']],
    ['review', ['user-code-review']],
    ['deliver', ['quality', 'delivery-receipt']],
  ]);
  for (const [action, stages] of expected) {
    const plan = createCardWorldLifecyclePlan({ intent: { action, target: 'V-next', scope: action, sourcePolicy: action === 'quality' ? 'review-and-repair' : null, ...(['quality', 'full', 'deliver'].includes(action) ? { knownFindingInventory } : {}) }, project, runId: `${action}-v-next`, sourceDigest: 'a'.repeat(64) });
    assert.deepEqual(plan.run.features.map(feature => feature.metadata.stage), stages, action);
    assert.equal(plan.stopCondition.action, action);
  }
  const quality = createCardWorldLifecyclePlan({ intent: { action: 'quality', target: 'V-next', scope: 'quality', sourcePolicy: 'review-and-repair', knownFindingInventory }, project, runId: 'quality-v-next', sourceDigest: 'a'.repeat(64) });
  assert.deepEqual(quality.run.features[0].allowedPaths, []);
  assert.equal(quality.run.features[0].metadata.sourcePolicy, 'read-only');
  assert.equal(quality.run.features[0].metadata.qualityFindingPolicy, 'repair-and-rereview');
  assert.equal(quality.stopCondition.type, 'quality-run-complete');
  const reviewOnly = createCardWorldLifecyclePlan({ intent: { action: 'quality', target: 'V-next', scope: 'quality', sourcePolicy: 'read-only', knownFindingInventory }, project, runId: 'quality-review-only-v-next', sourceDigest: 'a'.repeat(64) });
  assert.equal(reviewOnly.run.features[0].metadata.sourcePolicy, 'read-only');
  assert.equal(reviewOnly.run.features[0].metadata.qualityFindingPolicy, 'record-only');
  const deliver = createCardWorldLifecyclePlan({ intent: { action: 'deliver', target: 'V-next', scope: 'delivery-receipt', knownFindingInventory }, project, runId: 'deliver-v-next', sourceDigest: 'a'.repeat(64) });
  assert.equal(deliver.run.profileConfig.requireFinalQualityReview, true);
  assert.equal(deliver.run.profileConfig.requireUserCodeReview, true);
});

test('Collection consumer keeps ten game lanes, Feature dependencies, and one shared capability owner', () => {
  const descriptor = createTabletopCollectionProjectDescriptor({ workspaceRoot: process.cwd() });
  assert.equal(descriptor.workspace.rootSelector, 'git-worktree');
  assert.deepEqual(descriptor.gateRecipes.map(gate => gate.id), COLLECTION_FINAL_GATE_IDS);
  assert.deepEqual(descriptor.extensions.map(extension => extension.id), ['tabletop-collection-profile', 'codex-runtime']);
  assert.equal(descriptor.policy.maxConcurrency, 10);
  assert.equal(descriptor.policy.agentExecutionMode, 'conversation-visible');
  assert.equal(descriptor.policy.defaultRuntimePlugin, 'codex-conversation-runtime');
  assert.equal(descriptor.policy.promptCodecPlugin, 'reference-agent-prompt-codec');
  assert.deepEqual(descriptor.policy.runtimeConfigs['codex-conversation-runtime'], {});
  const games = Array.from({ length: 10 }, (_, index) => ({
    id: `game-${index + 1}`,
    features: [{ id: 'implementation', executionClass: 'agent-reasoning', acceptance: ['game accepted'], allowedPaths: [`packages/games/game-${index + 1}`], metadata: index === 0 ? { capabilityUses: ['shared-ui'] } : {} }],
  }));
  const graph = compileTabletopCollectionFeatureGraph({
    batchId: 'B1',
    games,
    sharedCapabilities: [{ key: 'shared-ui', feature: { id: 'shared/ui', executionClass: 'agent-reasoning', acceptance: ['shared UI accepted'], allowedPaths: ['packages/shared/ui'] } }],
  });
  assert.equal(new Set(graph.filter(feature => feature.metadata.gameId).map(feature => feature.laneId)).size, 10);
  assert.equal(graph.filter(feature => feature.metadata.capabilityOwner).length, 1);
  assert.deepEqual(graph.find(feature => feature.id === 'game-1/implementation').dependsOn, ['shared/ui']);
});

test('Collection consumer rejects an eleventh logical game', () => {
  assert.throws(() => compileTabletopCollectionFeatureGraph({ batchId: 'B1', games: Array.from({ length: 11 }, (_, index) => ({ id: `g${index}`, features: [{ id: 'work', executionClass: 'agent-reasoning', acceptance: ['done'], allowedPaths: [`g/${index}`] }] })) }), error => error.code === 'LOGICAL_GAME_LIMIT_EXCEEDED');
});

test('consumer descriptors do not retain Codex when another Runtime is selected', () => {
  assert.throws(() => createCardWorldProjectDescriptor({ workspaceRoot: process.cwd(), runtimePluginId: 'another-runtime' }), error => error.code === 'HEADLESS_EXECUTION_MODE_EXPLICIT_REQUIRED');
  assert.throws(() => createTabletopCollectionProjectDescriptor({ workspaceRoot: process.cwd(), runtimePluginId: 'another-runtime' }), error => error.code === 'HEADLESS_EXECUTION_MODE_EXPLICIT_REQUIRED');
  const engine = createCardWorldProjectDescriptor({ workspaceRoot: process.cwd(), runtimePluginId: 'another-runtime', agentExecutionMode: 'headless' });
  const collection = createTabletopCollectionProjectDescriptor({ workspaceRoot: process.cwd(), runtimePluginId: 'another-runtime', agentExecutionMode: 'headless' });
  assert.deepEqual(engine.extensions.map(extension => extension.id), ['cardworld-engine-profile']);
  assert.deepEqual(collection.extensions.map(extension => extension.id), ['tabletop-collection-profile']);
  assert.equal(engine.policy.agentExecutionMode, 'headless');
  assert.equal(collection.policy.agentExecutionMode, 'headless');
  const mixed = createCardWorldProjectDescriptor({ workspaceRoot: process.cwd(), runtimePluginId: 'another-runtime', runtimePluginIds: ['another-runtime', 'codex-cli-runtime'], agentExecutionMode: 'headless', actionExecution: { quality: { agentExecutionMode: 'headless', runtimePluginId: 'codex-cli-runtime' } } });
  assert.deepEqual(mixed.extensions.map(extension => extension.id), ['cardworld-engine-profile', 'codex-headless-runtime']);
  const explicit = createTabletopCollectionProjectDescriptor({ workspaceRoot: process.cwd(), runtimePluginId: 'another-runtime', agentExecutionMode: 'headless', runtimeExtension: { id: 'another-runtime-pack', version: '2.0.0', digest: 'a'.repeat(64) } });
  assert.deepEqual(explicit.extensions.map(extension => extension.id), ['tabletop-collection-profile', 'another-runtime-pack']);
});

test('every Engine and Collection state-changing action shares the conversation-visible Host Contract path by default', () => {
  const cases = [
    [createCardWorldProjectDescriptor({ workspaceRoot: process.cwd() }), cardWorldCommandManifest],
    [createTabletopCollectionProjectDescriptor({ workspaceRoot: process.cwd() }), tabletopCollectionCommandManifest],
  ];
  for (const [project, manifest] of cases) {
    const stateChangingActions = Object.entries(manifest.actions)
      .filter(([, action]) => Object.values(action.presets).some(preset => preset.stateChanging))
      .map(([action]) => action);
    assert(stateChangingActions.length > 0);
    for (const action of stateChangingActions) {
      const policy = resolveLifecycleExecutionPolicy({ project, action });
      assert.deepEqual({ mode: policy.mode, runtimePluginId: policy.runtimePluginId }, { mode: 'conversation-visible', runtimePluginId: 'codex-conversation-runtime' }, `${project.id}/${action}`);
    }
  }
});
