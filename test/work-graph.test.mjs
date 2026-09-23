import assert from 'node:assert/strict';
import test from 'node:test';
import { featuresConflict, normalizeFeature, scheduleFeatures, validateWorkGraph } from '../src/index.mjs';
import { feature } from './test-support.mjs';

test('work graph rejects cycles and detects real conflicts', () => {
  assert.throws(() => validateWorkGraph([feature('a', {}, { dependsOn: ['b'] }), feature('b', {}, { dependsOn: ['a'] })]), error => error.code === 'FEATURE_GRAPH_CYCLE');
  const [a, b, c] = validateWorkGraph([
    feature('a', {}, { allowedPaths: ['src/shared'] }),
    feature('b', {}, { allowedPaths: ['src/shared/file.mjs'] }),
    feature('c', {}, { allowedPaths: ['docs/other.md'] }),
  ]);
  assert.equal(featuresConflict(a, b), true);
  assert.equal(featuresConflict(a, c), false);
});

test('scheduler is fair across lanes while honoring conflicts', () => {
  const features = validateWorkGraph([
    feature('a1', {}, { laneId: 'a', allowedPaths: ['a/1'] }),
    feature('a2', {}, { laneId: 'a', allowedPaths: ['a/2'] }),
    feature('b1', {}, { laneId: 'b', allowedPaths: ['b/1'] }),
  ]);
  assert.deepEqual(scheduleFeatures({ features, limit: 3 }).map(item => item.id), ['a1', 'b1', 'a2']);
});

test('normalized lanes never derive from business-specific fields', () => {
  assert.equal(normalizeFeature({ id: 'x', gameId: 'game-a' }).laneId, 'default');
  assert.equal(normalizeFeature({ id: 'x', laneId: 'lane-a', gameId: 'game-a' }).laneId, 'lane-a');
  assert.equal(normalizeFeature({ id: 'x', ownerRole: 'worker' }).laneId, 'worker');
});

test('new work nodes fail closed unless explicitly classified as Agent reasoning', () => {
  assert.throws(
    () => validateWorkGraph([{ id: 'undeclared', acceptance: ['done'], dependsOn: [], allowedPaths: [] }]),
    error => error?.code === 'FEATURE_EXECUTION_CLASS_INVALID',
  );
  assert.throws(
    () => validateWorkGraph([feature('process-smuggled-as-feature', {}, { executionClass: 'deterministic-process' })]),
    error => error?.code === 'FEATURE_EXECUTION_CLASS_INVALID',
  );
});
