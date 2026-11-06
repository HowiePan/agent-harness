// Independent mutable JSON graphs, without structuredClone's repeated allocation
// of immutable long strings embedded in every approved-plan projection.
export const cloneJson = value => {
  const seen = new WeakMap();
  const copy = value => {
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'function' || typeof value === 'symbol') return structuredClone(value);
      return value;
    }
    if (seen.has(value)) return seen.get(value);
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return structuredClone(value);
    const result = Array.isArray(value) ? Array(value.length) : {};
    seen.set(value, result);
    for (const key of Object.keys(value)) Object.defineProperty(result, key, {
      value: copy(value[key]), enumerable: true, writable: true, configurable: true,
    });
    return result;
  };
  return copy(value);
};
