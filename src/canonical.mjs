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
export const digestJson = value => sha256(canonicalize(value));
export const newId = prefix => `${prefix}_${randomUUID()}`;

export const withoutKeys = (value, keys) => {
  const copy = structuredClone(value);
  for (const key of keys) delete copy[key];
  return copy;
};
