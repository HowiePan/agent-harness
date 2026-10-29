import { assert } from '../../common/errors.mjs';
import { digestAmendmentJson as digestJson } from './amendment-json.mjs';
import { validProposalId } from './proposal-id.mjs';
import { validateDeliveryBatches, DELIVERY_BATCH_POLICY } from './delivery-batches.mjs';

export const validateFeatureSplitScope = scope => {
  const splits = scope.featureSplits ?? [];
  assert(Array.isArray(splits) && new Set(splits.map(item => item.featureId)).size === splits.length,
    'PLAN_AMENDMENT_SPLIT_SCOPE_INVALID', 'Split sources must be distinct.');
  for (const item of splits) assert(item && Object.keys(item).sort().join(',') === 'featureId,maxNewFeatures,prefix'
    && scope.featureIds.includes(item.featureId) && validProposalId(item.featureId)
    && item.prefix === `${item.featureId}-` && Number.isInteger(item.maxNewFeatures)
    && item.maxNewFeatures >= 1 && item.maxNewFeatures <= 20,
  'PLAN_AMENDMENT_SPLIT_SCOPE_INVALID', 'Register bounded child prefixes for existing affected Features.');
  if (scope.batchPolicy) assert(Object.keys(scope.batchPolicy).every(key => ['maxBatchesPerFeature', 'policy'].includes(key))
    && (!scope.batchPolicy.policy || scope.batchPolicy.policy === DELIVERY_BATCH_POLICY)
    && Number.isInteger(scope.batchPolicy.maxBatchesPerFeature)
    && scope.batchPolicy.maxBatchesPerFeature >= 1 && scope.batchPolicy.maxBatchesPerFeature <= 20,
  'PLAN_AMENDMENT_BATCH_POLICY_INVALID', 'Planning batch limits must be bounded to 1–20.');
};

/** Original proposals remain convergence owners; only explicitly scoped children may be appended. */
export const assertAmendmentMembership = (base, next, scope) => {
  const before = base.proposedFeatures;
  const after = next.proposedFeatures;
  assert(Array.isArray(after) && after.length >= before.length
    && digestJson(before.map(item => [item.projectId, item.id, item.disposition]))
      === digestJson(after.slice(0, before.length).map(item => [item.projectId, item.id, item.disposition])),
  'PLAN_AMENDMENT_IDENTITY_CHANGED', 'Original proposal identities and order must remain intact.');
  const additions = after.slice(before.length);
  const declared = scope.featureSplits ?? [];
  const used = new Map();
  for (const child of additions) {
    const split = declared.find(item => child.id.startsWith(item.prefix) && child.splitFrom === item.featureId);
    const parent = split && before.find(item => item.id === split.featureId);
    assert(parent?.disposition === 'project-owned' && child.projectId === parent.projectId
      && child.disposition === parent.disposition && validProposalId(child.id)
      && !before.some(item => item.id === child.id),
    'PLAN_AMENDMENT_SPLIT_SCOPE_VIOLATION', 'New proposals require a registered project-owned split source.');
    used.set(parent.id, (used.get(parent.id) ?? 0) + 1);
    assert(used.get(parent.id) <= split.maxNewFeatures, 'PLAN_AMENDMENT_SPLIT_LIMIT', 'Too many children.');
    const anchor = after.find(item => item.id === parent.id);
    assert(anchor.dependsOn.includes(child.id) && parent.dependsOn.every(id => child.dependsOn.includes(id)),
      'PLAN_AMENDMENT_SPLIT_DEPENDENCY', 'Children retain prerequisites and feed their original convergence owner.');
    assert(Array.isArray(child.allowedPaths) && child.allowedPaths.every(path => parent.allowedPaths.some(root => path === root || path.startsWith(`${root}/`)))
      && (parent.forbiddenPaths ?? []).every(path => child.forbiddenPaths?.includes(path)),
    'PLAN_AMENDMENT_SPLIT_PATHS', 'A split cannot expand source authority or lose forbidden paths.');
  }
  for (const [index, original] of before.entries()) {
    const item = after[index];
    assert(scope.featureIds.includes(original.id) || digestJson(original) === digestJson(item),
      'PLAN_AMENDMENT_SCOPE_VIOLATION', 'An unaffected proposal changed.');
    assert(item.splitFrom === original.splitFrom, 'PLAN_AMENDMENT_IDENTITY_CHANGED', 'Existing budget ancestry cannot change.');
    if (used.has(original.id)) for (const key of ['contracts', 'verification']) {
      assert((original[key] ?? []).every(value => (item[key] ?? []).some(row => digestJson(row) === digestJson(value))),
        'PLAN_AMENDMENT_SPLIT_ACCEPTANCE', 'The convergence owner must retain every original contract and verification.');
    }
  }
  assert(after.filter(item => item.disposition === 'project-owned').length <= 100,
    'PLAN_AMENDMENT_SPLIT_LIMIT', 'The implementation compiler supports at most 100 owned proposals.');
  if (scope.batchPolicy) for (const item of after.filter(row => row.disposition === 'project-owned'
    && (scope.featureIds.includes(row.id) || additions.includes(row)))) {
    if (scope.batchPolicy.policy === DELIVERY_BATCH_POLICY) {
      validateDeliveryBatches(item, { maxBatches: scope.batchPolicy.maxBatchesPerFeature });
      continue;
    }
    const batches = item.deliveryBatches;
    assert(Array.isArray(batches) && batches.length > 0 && batches.length <= scope.batchPolicy.maxBatchesPerFeature
      && new Set(batches.map(row => row.id)).size === batches.length,
    'PLAN_AMENDMENT_BATCH_PLAN_REQUIRED', 'Affected Features require explicit bounded delivery batches.');
    for (const batch of batches) assert(typeof batch.id === 'string' && batch.id.trim()
      && typeof batch.objective === 'string' && batch.objective.trim()
      && ['acceptance', 'verification'].every(key => Array.isArray(batch[key]) && batch[key].length
        && batch[key].every(value => typeof value === 'string' && value.trim()))
      && typeof batch.sizing?.basis === 'string' && batch.sizing.basis.trim()
      && typeof batch.sizing?.reserve === 'string' && batch.sizing.reserve.trim(),
    'PLAN_AMENDMENT_BATCH_PLAN_REQUIRED', 'Each batch needs a complete objective, acceptance, checks, sizing basis and reserve.');
  }
  return before.filter((item, index) => digestJson(item) !== digestJson(after[index])).map(item => item.id).concat(additions.map(item => item.id));
};
