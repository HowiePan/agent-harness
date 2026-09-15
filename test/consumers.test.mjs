import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CARDWORLD_FINAL_GATE_IDS,
  COLLECTION_FINAL_GATE_IDS,
  compileCardWorldFeatureGraph,
  compileTabletopCollectionFeatureGraph,
  createCardWorldProjectDescriptor,
  createTabletopCollectionProjectDescriptor,
} from '../src/consumers/index.mjs';

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
  const graph = compileCardWorldFeatureGraph({
    requirement: { id: 'v-next', acceptance: ['requirement is singular and approved'] },
    features: [
      { id: 'plan', stage: 'version-planning', acceptance: ['plan accepted'], allowedPaths: ['docs/versions'] },
      { id: 'implementation/a', stage: 'implementation', acceptance: ['tests pass'], allowedPaths: ['card_world_engine/src/a.rs'], dependsOn: ['plan'] },
      { id: 'implementation/b', stage: 'implementation', acceptance: ['tests pass'], allowedPaths: ['card_world_engine/src/b.rs'], dependsOn: ['plan'] },
    ],
  });
  assert.equal(graph.filter(feature => feature.metadata.canonical).length, 1);
  assert.deepEqual(graph.find(feature => feature.id === 'plan').dependsOn, ['requirement/v-next']);
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
    features: [{ id: 'implementation', acceptance: ['game accepted'], allowedPaths: [`packages/games/game-${index + 1}`], metadata: index === 0 ? { capabilityUses: ['shared-ui'] } : {} }],
  }));
  const graph = compileTabletopCollectionFeatureGraph({
    batchId: 'B1',
    games,
    sharedCapabilities: [{ key: 'shared-ui', feature: { id: 'shared/ui', acceptance: ['shared UI accepted'], allowedPaths: ['packages/shared/ui'] } }],
  });
  assert.equal(new Set(graph.filter(feature => feature.metadata.gameId).map(feature => feature.laneId)).size, 10);
  assert.equal(graph.filter(feature => feature.metadata.capabilityOwner).length, 1);
  assert.deepEqual(graph.find(feature => feature.id === 'game-1/implementation').dependsOn, ['shared/ui']);
});

test('Collection consumer rejects an eleventh logical game', () => {
  assert.throws(() => compileTabletopCollectionFeatureGraph({ batchId: 'B1', games: Array.from({ length: 11 }, (_, index) => ({ id: `g${index}`, features: [{ id: 'work', acceptance: ['done'], allowedPaths: [`g/${index}`] }] })) }), error => error.code === 'LOGICAL_GAME_LIMIT_EXCEEDED');
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
  const explicit = createTabletopCollectionProjectDescriptor({ workspaceRoot: process.cwd(), runtimePluginId: 'another-runtime', agentExecutionMode: 'headless', runtimeExtension: { id: 'another-runtime-pack', version: '2.0.0', digest: 'a'.repeat(64) } });
  assert.deepEqual(explicit.extensions.map(extension => extension.id), ['tabletop-collection-profile', 'another-runtime-pack']);
});
