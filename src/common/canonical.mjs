import { createHash, randomUUID } from 'node:crypto';
import { assert, fail } from './errors.mjs';

const normalize = value => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('CANONICAL_NUMBER_INVALID', 'Canonical JSON does not support non-finite numbers.');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      assert(value[key] !== undefined, 'CANONICAL_UNDEFINED', `Canonical JSON does not support undefined at ${key}.`);
      output[key] = normalize(value[key]);
    }
    return output;
  }
  fail('CANONICAL_TYPE_INVALID', `Canonical JSON does not support ${typeof value}.`);
};

export const canonicalize = value => JSON.stringify(normalize(value));
export const sha256 = value => createHash('sha256').update(value).digest('hex');
// Hash the identical canonical byte sequence incrementally. Authority histories
// contain repeated large contracts: do not allocate a second normalized graph
// and a whole serialized string just to compute their digest.
export const digestJson = value => {
  const hash = createHash('sha256');
  const visit = value => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') { hash.update(JSON.stringify(value)); return; }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail('CANONICAL_NUMBER_INVALID', 'Canonical JSON does not support non-finite numbers.');
      hash.update(JSON.stringify(Object.is(value, -0) ? 0 : value)); return;
    }
    if (Array.isArray(value)) {
      hash.update('[');
      for (let i = 0; i < value.length; i++) { if (i) hash.update(','); if (i in value) visit(value[i]); else hash.update('null'); }
      hash.update(']'); return;
    }
    if (typeof value === 'object') {
      hash.update('{'); let first = true;
      const order = {};
      for (const key of Object.keys(value).sort()) {
        assert(value[key] !== undefined, 'CANONICAL_UNDEFINED', `Canonical JSON does not support undefined at ${key}.`);
        // Match JSON.stringify's integer-key ordering and the established
        // normalizer's plain-object __proto__ assignment behavior exactly.
        if (key === '__proto__') normalize(value[key]); else order[key] = null;
      }
      for (const key of Object.keys(order)) {
        if (!first) hash.update(','); first = false; hash.update(JSON.stringify(key)); hash.update(':'); visit(value[key]);
      }
      hash.update('}'); return;
    }
    fail('CANONICAL_TYPE_INVALID', `Canonical JSON does not support ${typeof value}.`);
  };
  visit(value); return hash.digest('hex');
};
export const digestJsonOmitting = (value, keys) => digestJson(Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key))));
export const newId = prefix => `${prefix}_${randomUUID()}`;

export const withoutKeys = (value, keys) => {
  const copy = structuredClone(value);
  for (const key of keys) delete copy[key];
  return copy;
};
