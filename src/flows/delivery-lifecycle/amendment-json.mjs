import { assert } from '../../common/errors.mjs';
import { sha256 } from '../../common/canonical.mjs';

const exactKey = '$harness.exact-plan-number';
const exact = value => value && typeof value === 'object' && Object.keys(value).length === 1
  && typeof value[exactKey] === 'string';

/** Inventory bounds may exceed IEEE-754: retain their original numeric tokens. */
export const parseAmendmentJson = text => {
  assert(typeof JSON.rawJSON === 'function', 'PLAN_AMENDMENT_LOSSLESS_JSON_REQUIRED', 'This Node runtime needs lossless JSON token support.');
  return JSON.parse(text, (_key, value, context) => {
    assert(!(value && typeof value === 'object' && Object.hasOwn(value, exactKey)),
      'PLAN_AMENDMENT_RESERVED_JSON_KEY', 'Input collides with the internal exact-number marker.');
    if (typeof value !== 'number') return value;
    assert(typeof context?.source === 'string', 'PLAN_AMENDMENT_LOSSLESS_JSON_REQUIRED', 'JSON numeric source tokens are unavailable.');
    return !Number.isFinite(value) || !Number.isSafeInteger(value) || Object.is(value, -0)
      || JSON.stringify(value) !== context.source ? { [exactKey]: context.source } : value;
  });
};

export const stringifyAmendmentJson = (value, space = 2) => JSON.stringify(value,
  (_key, item) => exact(item) ? JSON.rawJSON(item[exactKey]) : item, space);

const sorted = value => {
  if (exact(value)) return value;
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
};
export const digestAmendmentJson = value => sha256(stringifyAmendmentJson(sorted(value), 0));
