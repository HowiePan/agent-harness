import { assert } from '../../common/errors.mjs';
import { digestAmendmentJson as digestJson, isExactAmendmentNumber } from './amendment-json.mjs';
import { applyAmendmentChanges } from './plan-amendment.mjs';

const escaped = key => String(key).replaceAll('~', '~0').replaceAll('/', '~1');
const bytes = value => Buffer.byteLength(JSON.stringify(value));

/** Emit a smaller exact delta; additions pin their immutable original parent. */
export const compactAmendmentChanges = (base, changes, allowedPointers) => {
  // Keep the original per-document bounds and validate all incoming preimages.
  const expected = applyAmendmentChanges(base, changes, allowedPointers);
  const digestCache = new WeakMap();
  const digest = value => {
    if (!value || typeof value !== 'object') return digestJson(value);
    if (!digestCache.has(value)) digestCache.set(value, digestJson(value));
    return digestCache.get(value);
  };
  const walk = (before, after, path) => {
    if (digest(before) === digest(after)) return [];
    const replacement = [{ path, expectedDigest: digest(before), value: after }];
    if (!before || !after || typeof before !== 'object' || typeof after !== 'object'
      || isExactAmendmentNumber(before) || isExactAmendmentNumber(after)
      || Array.isArray(before) !== Array.isArray(after)
      || Object.keys(before).some(key => !Object.hasOwn(after, key))) return replacement;
    const detailed = [];
    for (const key of Object.keys(after)) {
      const member = `${path}/${escaped(key)}`;
      if (Object.hasOwn(before, key)) detailed.push(...walk(before[key], after[key], member));
      else detailed.push({ op: 'add', path: member, expectedDigest: digest(before), value: after[key] });
      if (detailed.length > 1000) return replacement;
    }
    return bytes(detailed) < bytes(replacement) ? detailed : replacement;
  };
  const read = (object, path) => path.slice(1).split('/').map(key => key.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce((value, key) => value[key], object);
  const compact = changes.flatMap(change => change.op === 'add' ? [change]
    : walk(read(base, change.path), change.value, change.path));
  const selected = compact.length <= 1000 && bytes(compact) < bytes(changes) ? compact : changes;
  const actual = applyAmendmentChanges(base, selected, allowedPointers);
  assert(digestJson(actual) === digestJson(expected),
    'PLAN_AMENDMENT_COMPACTION_MISMATCH', 'Compaction must preserve the exact resulting JSON, including numeric tokens.');
  return structuredClone(selected);
};
