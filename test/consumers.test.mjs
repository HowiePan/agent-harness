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
  assert.deepEqual(descriptor.extensions.map(extension => extension.id), ['cardworld-engine-profile', 'codex-runtime']);
  assert.equal(descriptor.policy.defaultRuntimePlugin, 'codex-cli-runtime');
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
  assert.deepEqual(descriptor.gateRecipes.map(gate => gate.id), COLLECTION_FINAL_GATE_IDS);
  assert.deepEqual(descriptor.extensions.map(extension => extension.id), ['tabletop-collection-profile', 'codex-runtime']);
  assert.equal(descriptor.policy.maxConcurrency, 10);
  assert.equal(descriptor.policy.defaultRuntimePlugin, 'codex-isolated-runtime');
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
  const engine = createCardWorldProjectDescriptor({ workspaceRoot: process.cwd(), runtimePluginId: 'another-runtime' });
  const collection = createTabletopCollectionProjectDescriptor({ workspaceRoot: process.cwd(), runtimePluginId: 'another-runtime' });
  assert.deepEqual(engine.extensions.map(extension => extension.id), ['cardworld-engine-profile']);
  assert.deepEqual(collection.extensions.map(extension => extension.id), ['tabletop-collection-profile']);
  const explicit = createTabletopCollectionProjectDescriptor({ workspaceRoot: process.cwd(), runtimePluginId: 'another-runtime', runtimeExtension: { id: 'another-runtime-pack', version: '2.0.0', digest: 'a'.repeat(64) } });
  assert.deepEqual(explicit.extensions.map(extension => extension.id), ['tabletop-collection-profile', 'another-runtime-pack']);
});
