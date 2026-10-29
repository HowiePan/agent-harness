import { assert } from '../common/errors.mjs';
import { digestJson, withoutKeys } from '../common/canonical.mjs';

const used = item => item.budgetKind === 'progress' ? item.used : item.failures;

/** Transfer counters from pinned Authority, never from caller-supplied numbers. */
export const resolveAttemptCarryover = async (input, features, store) => {
  const spec = input.attemptCarryover;
  if (!spec) return null;
  assert(Array.isArray(spec.sources) && spec.sources.length && Array.isArray(spec.logicalRoots) && spec.logicalRoots.length
    && new Set(spec.logicalRoots).size === spec.logicalRoots.length
    && new Set(spec.sources.map(item => item.runId)).size === spec.sources.length,
  'ATTEMPT_CARRYOVER_INVALID', 'Counter transfer requires distinct pinned sources and stable roots.');
  const roots = new Set(spec.logicalRoots);
  assert([...roots].every(root => features.some(item => item.logicalRoot === root)),
    'ATTEMPT_CARRYOVER_ROOT_MISMATCH', 'Every transferred root must exist in the new graph.');
  const sources = [];
  const attempts = {};
  const submissions = new Map();
  const exhausted = new Set();
  for (const pin of spec.sources) {
    assert(pin.runId !== input.runId, 'ATTEMPT_CARRYOVER_INVALID', 'A Run cannot inherit itself.');
    const prior = await store.read(input.projectId, pin.runId);
    assert(prior.authorityDigest === pin.authorityDigest
      && !prior.leases.some(item => ['requested', 'active'].includes(item.status))
      && !prior.dispatches.some(item => ['requested', 'assigned'].includes(item.status)),
    'ATTEMPT_CARRYOVER_SOURCE_CHANGED', 'Counter transfer requires the exact idle prior Authority.');
    sources.push(prior);
    const owned = new Set(prior.features.filter(item => roots.has(item.logicalRoot)).map(item => item.id));
    for (const [key, item] of Object.entries(prior.attempts).filter(([, value]) => roots.has(value.logicalRoot))) {
      assert(item.key === key && Number.isSafeInteger(used(item)) && used(item) >= 0,
        'ATTEMPT_CARRYOVER_INVALID', 'Historical counters must retain their original identity and kind.');
      const selected = attempts[key];
      if (!selected || used(item) > used(selected) || used(item) === used(selected) && item.limit > selected.limit) attempts[key] = structuredClone(item);
    }
    for (const item of prior.submissions.filter(row => owned.has(row.featureId) && row.result.status !== 'completed'
      && features.some(feature => feature.id === row.featureId))) {
      assert(item.submissionDigest === digestJson(withoutKeys(item, ['submissionDigest'])),
        'ATTEMPT_CARRYOVER_HISTORY_INVALID', 'Historical Submissions must retain their original digest.');
      submissions.set(item.submissionId, structuredClone(item));
    }
  }
  // Follow the actual transfer lineage. A different explicit task may reuse a
  // root name; its unrelated historical allowance is not this ledger's budget.
  const all = await store.list(input.projectId);
  const family = new Set(sources.map(item => item.runId));
  let changed;
  do {
    changed = false;
    for (const run of all) {
      const parents = [...(run.metadata?.attemptCarryover?.sources ?? []).map(item => item.runId),
        run.metadata?.completionCarryover?.priorRunId].filter(Boolean);
      if (!family.has(run.runId) && parents.some(id => family.has(id))) { family.add(run.runId); changed = true; }
    }
  } while (changed);
  for (const prior of all.filter(item => family.has(item.runId) && item.runId !== input.runId)) for (const [key, item] of Object.entries(prior.attempts)
    .filter(([, value]) => roots.has(value.logicalRoot))) {
    assert(attempts[key] && used(attempts[key]) >= used(item) && attempts[key].limit >= item.limit,
      'ATTEMPT_CARRYOVER_STALE', 'A newer counter or approved allowance exists for this stable root.');
  }
  for (const [key, item] of Object.entries(attempts)) {
    item.exhausted = used(item) >= item.limit;
    if (!item.exhausted) continue;
    const anchor = features.find(feature => feature.logicalRoot === item.logicalRoot
      && sources.some(source => source.submissions.some(submission => submission.featureId === feature.id && submission.attemptBudgetKey === key)));
    assert(anchor, 'ATTEMPT_CARRYOVER_ANCHOR_REQUIRED', 'An exhausted counter needs its stable original Feature for explicit budget approval.');
    exhausted.add(anchor.id);
  }
  return { attempts, submissions: [...submissions.values()], exhausted: [...exhausted],
    receipt: { sources: spec.sources, logicalRoots: spec.logicalRoots, submissionIds: [...submissions.keys()] },
    extensions: sources.flatMap(source => source.metadata?.attemptBudgetExtensions ?? []) };
};
