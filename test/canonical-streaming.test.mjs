import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalize, digestJson, digestJsonOmitting, sha256, withoutKeys } from '../src/common/canonical.mjs';
test('streamed digest preserves the exact established canonical byte contract', () => {
  const repeated = 'contract-😀-\\-\"'.repeat(20000);
  const sparse = Array(3); sparse[1] = -0;
  for (const value of [null, true, false, 12.5, -0, '\ud800', '😀', [], {}, sparse,
    { z: [1, { b: '\\', a: repeated }], a: repeated, n: null }, { '10': 'ten', '2': 'two', a: 0 },
    JSON.parse('{"__proto__":{"legacy":1},"constructor":2,"a":3}')]) {
    assert.equal(digestJson(value), sha256(canonicalize(value)));
  }
  const record = { authorityDigest: 'old', nested: { value: repeated }, values: [1, 2] };
  assert.equal(digestJsonOmitting(record, ['authorityDigest']), digestJson(withoutKeys(record, ['authorityDigest'])));
  assert.equal(record.authorityDigest, 'old');
});
test('streamed digest retains canonical rejection rules', () => {
  for (const value of [NaN, Infinity]) assert.throws(() => digestJson(value), { code: 'CANONICAL_NUMBER_INVALID' });
  assert.throws(() => digestJson({ a: undefined }), { code: 'CANONICAL_UNDEFINED' });
  assert.throws(() => digestJson([undefined]), { code: 'CANONICAL_TYPE_INVALID' });
});
