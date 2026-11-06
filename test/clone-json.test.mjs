import assert from 'node:assert/strict';
import test from 'node:test';
import { cloneJson } from '../src/common/clone-json.mjs';
import { digestJson } from '../src/common/canonical.mjs';
test('plan projections retain exact values and independent mutable objects', () => {
  const text = 'immutable contract'.repeat(20000);
  const original = { plan: { text, checks: [{ name: 'check' }] }, array: [text, 0, null] };
  const a = cloneJson(original), b = cloneJson(original);
  assert.deepEqual(a, structuredClone(original)); assert.equal(digestJson(a), digestJson(original));
  a.plan.checks[0].name = 'changed'; a.array.push('new');
  assert.equal(original.plan.checks[0].name, 'check'); assert.equal(b.plan.checks[0].name, 'check');
  assert.equal(b.array.length, 3);
});
test('JSON clone preserves sparse arrays, explicit keys, aliases and cycles within each copy', () => {
  const array = Array(2); array[1] = undefined; array.extra = 'x';
  const value = JSON.parse('{"__proto__":{"safe":1},"constructor":"data"}'); value.array = array;
  value.alias = array; value.self = value;
  const copy = cloneJson(value);
  assert.deepEqual(copy, structuredClone(value)); assert.equal(copy.self, copy); assert.equal(copy.alias, copy.array);
  assert.notEqual(copy.array, value.array);
});
