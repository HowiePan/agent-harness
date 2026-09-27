import { assert } from '../../common/errors.mjs';

export const normalizeQualityReviewLimit = input => {
  const limit = input ?? { mode: 'bounded', maxRechecks: 2 };
  assert(limit && typeof limit === 'object' && !Array.isArray(limit), 'QUALITY_REVIEW_LIMIT_INVALID', 'Quality review limit must be an object.');
  assert(limit.mode === 'bounded' || limit.mode === 'unbounded', 'QUALITY_REVIEW_LIMIT_INVALID', 'Quality review limit mode must be bounded or unbounded.');
  if (limit.mode === 'unbounded') {
    assert(Object.keys(limit).every(key => key === 'mode'), 'QUALITY_REVIEW_LIMIT_INVALID', 'Unbounded quality review limit has no numeric maximum.');
    return { mode: 'unbounded' };
  }
  assert(Number.isInteger(limit.maxRechecks) && limit.maxRechecks >= 0 && Object.keys(limit).every(key => ['mode', 'maxRechecks'].includes(key)), 'QUALITY_REVIEW_LIMIT_INVALID', 'Bounded quality review limit requires a non-negative maxRechecks integer.');
  return { mode: 'bounded', maxRechecks: limit.maxRechecks };
};

export const qualityReviewCount = (state, qualityRoot = null) => {
  const history = state?.profile?.config?.priorQualityReviews ?? 0;
  const prior = Number(typeof history === 'object' ? history[qualityRoot] ?? 0 : history);
  return prior + (state?.features ?? []).filter(feature => feature.metadata?.qualityReview === true && (!qualityRoot || feature.metadata.qualityRoot === qualityRoot)).length;
};

export const qualityReviewBudgetExhausted = (state, qualityRoot = null) => {
  const limit = normalizeQualityReviewLimit(state?.profile?.config?.qualityReviewLimit);
  return limit.mode === 'bounded' && qualityReviewCount(state, qualityRoot) >= 1 + limit.maxRechecks;
};
