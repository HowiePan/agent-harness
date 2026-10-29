import { digestJson } from '../common/canonical.mjs';
import { assert } from '../common/errors.mjs';

/** Coalesce identical bounded obligations, retaining every resolved declaration location. */
export const mergeImplementationObligations = items => {
  const unique = new Map();
  for (const item of items) {
    const { sourceOccurrences, ...content } = item;
    assert(Array.isArray(sourceOccurrences) && sourceOccurrences.length,
      'IMPLEMENTATION_OBLIGATION_SOURCE_REQUIRED', 'Bounded obligations require their pinned declaration locations.');
    const previous = unique.get(item.id);
    if (!previous) { unique.set(item.id, structuredClone(item)); continue; }
    const { sourceOccurrences: priorOccurrences, ...priorContent } = previous;
    assert(digestJson(content) === digestJson(priorContent), 'IMPLEMENTATION_OBLIGATION_ID_CONFLICT',
      'Identical obligation IDs cannot conceal different pinned requirements.');
    previous.sourceOccurrences = [...new Map([...priorOccurrences, ...sourceOccurrences]
      .map(origin => [digestJson(origin), structuredClone(origin)])).values()];
  }
  return [...unique.values()];
};
