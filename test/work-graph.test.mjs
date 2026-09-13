import assert from 'node:assert/strict';
import test from 'node:test';
import { featuresConflict, scheduleFeatures, validateWorkGraph } from '../src/index.mjs';
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
