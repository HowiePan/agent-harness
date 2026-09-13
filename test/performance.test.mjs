import assert from 'node:assert/strict';
import test from 'node:test';
import { scheduleFeatures, validateWorkGraph } from '../src/index.mjs';
import { feature } from './test-support.mjs';

test('large Feature graph schedules a conflict-free wave within the reference SLO', () => {
  const features = validateWorkGraph(Array.from({ length: 1000 }, (_, index) => feature(`feature-${index}`, {}, { laneId: `lane-${index % 10}`, allowedPaths: [`isolated/${index}`] })));
  const started = performance.now();
  const selected = scheduleFeatures({ features, limit: 100 });
  const elapsed = performance.now() - started;
  assert.equal(selected.length, 100);
  assert.ok(elapsed < 2000, `scheduler took ${elapsed}ms`);
});
