import { assert } from './errors.mjs';

export const AUTO_CONCURRENCY = 'auto';
export const AUTO_CONCURRENCY_LIMIT = Number.MAX_SAFE_INTEGER;

/**
 * Resolve an optional concurrency setting without turning the auto mode into
 * an accidental serial limit. A finite value remains an explicit upper bound;
 * auto falls back to the supplied policy default.
 */
export const resolveConcurrencyLimit = (value, fallback) => {
  if (value === undefined || value === null || value === AUTO_CONCURRENCY) return fallback;
  const numeric = Number(value);
  assert(Number.isFinite(numeric) && numeric >= 1, 'CONCURRENCY_LIMIT_INVALID', 'Concurrency limit must be a positive number or auto.');
  return Math.floor(numeric);
};
