import { sha256 } from '../../common/canonical.mjs';
import { digestAmendmentJson as digestJson, stringifyAmendmentJson } from './amendment-json.mjs';
import { assert } from '../../common/errors.mjs';
import { assertAmendmentMembership, validateFeatureSplitScope } from './amendment-feature-splits.mjs';
import { readAmendmentReference } from './amendment-reference.mjs';

export const AMENDMENT_VERSION = 'plan-amendment/1';
const hash = value => /^[a-f0-9]{64}$/.test(value ?? '');
const safePath = value => typeof value === 'string' && !/[:\\\u0000-\u001f*?]/.test(value)
  && value.split('/').every(part => part && !['.', '..'].includes(part));
const tokens = pointer => {
  assert(typeof pointer === 'string' && pointer.startsWith('/') && !/~(?![01])/u.test(pointer),
    'PLAN_AMENDMENT_POINTER_INVALID', 'Amendment requires a non-root JSON pointer.');
  const parts = pointer.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  assert(parts.every(part => !['__proto__', 'prototype', 'constructor'].includes(part)),
    'PLAN_AMENDMENT_POINTER_INVALID', 'Prototype paths are forbidden.');
  return parts;
};
export const readAmendmentPointer = (object, pointer) => tokens(pointer).reduce((value, key) => {
  assert(value !== null && typeof value === 'object' && Object.hasOwn(value, key),
    'PLAN_AMENDMENT_REFERENCE_MISSING', `Missing amendment reference: ${pointer}`);
  return value[key];
}, object);

export const applyAmendmentChanges = (base, changes, allowedPointers) => {
  assert(Array.isArray(changes) && changes.length <= 1000 && Array.isArray(allowedPointers),
    'PLAN_AMENDMENT_CHANGES_INVALID', 'Amendment changes and registered pointer bounds are required.');
  assert(Buffer.byteLength(JSON.stringify(changes)) <= 2 * 1024 * 1024,
    'PLAN_AMENDMENT_TOO_LARGE', 'A delta exceeding 2 MiB requires Replan.');
  const output = structuredClone(base);
  const seen = [];
  for (const change of changes) {
    const adding = change?.op === 'add';
    assert(change && Object.keys(change).sort().join(',') === (adding ? 'expectedDigest,op,path,value' : 'expectedDigest,path,value')
      && hash(change.expectedDigest) && allowedPointers.some(path => {
        tokens(path);
        return change.path === path || change.path.startsWith(`${path}/`);
      }), 'PLAN_AMENDMENT_SCOPE_VIOLATION', `Unregistered amendment path: ${change?.path}`);
    const parts = tokens(change.path);
    assert(!seen.some(path => path === change.path || path.startsWith(`${change.path}/`) || change.path.startsWith(`${path}/`)),
      'PLAN_AMENDMENT_OVERLAPPING_CHANGES', 'Duplicate and overlapping changes are forbidden.');
    seen.push(change.path);
    const parentAt = object => parts.slice(0, -1).reduce((value, key) => {
      assert(value && typeof value === 'object' && Object.hasOwn(value, key),
        'PLAN_AMENDMENT_REFERENCE_MISSING', `Missing amendment parent: ${change.path}`);
      return value[key];
    }, object);
    const parent = parentAt(output), original = parentAt(base), key = parts.at(-1);
    if (adding) {
      assert(original && typeof original === 'object' && parent && typeof parent === 'object'
        && !Object.hasOwn(original, key) && !Object.hasOwn(parent, key),
      'PLAN_AMENDMENT_ADD_INVALID', `Add requires an absent original member: ${change.path}`);
      assert(digestJson(original) === change.expectedDigest,
        'PLAN_AMENDMENT_BASE_STALE', `Amendment parent preimage changed: ${change.path}`);
      if (Array.isArray(original)) assert(/^(0|[1-9]\d*)$/.test(key)
        && Number.isSafeInteger(Number(key)) && Number(key) === parent.length && Number(key) >= original.length,
      'PLAN_AMENDMENT_ADD_INVALID', 'Arrays permit ordered tail additions only, never insertion or sparse members.');
    } else {
      assert(digestJson(readAmendmentPointer(base, change.path)) === change.expectedDigest,
        'PLAN_AMENDMENT_BASE_STALE', `Amendment preimage changed: ${change.path}`);
      assert(digestJson(change.value) !== change.expectedDigest,
        'PLAN_AMENDMENT_EMPTY_CHANGE', `No-op replacement: ${change.path}`);
    }
    parent[key] = structuredClone(change.value);
  }
  return output;
};

export const validateAmendmentScope = scope => {
  assert(scope?.version === AMENDMENT_VERSION && safePath(scope.artifactRoot)
    && Array.isArray(scope.featureIds) && scope.featureIds.length > 0
    && new Set(scope.featureIds).size === scope.featureIds.length
    && scope.featureIds.every(id => typeof id === 'string' && id.trim())
    && Array.isArray(scope.planPointers) && Array.isArray(scope.documents) && scope.documents.length <= 16
    && Object.keys(scope).every(key => ['version', 'artifactRoot', 'featureIds', 'planPointers', 'documents', 'baselineCompatibilityPaths', 'featureSplits', 'batchPolicy'].includes(key))
    && (scope.baselineCompatibilityPaths ?? []).every(safePath),
  'PLAN_AMENDMENT_SCOPE_REQUIRED', 'Amend requires an explicit registered, bounded amendmentScope.');
  validateFeatureSplitScope(scope);
  for (const path of scope.planPointers) {
    tokens(path);
    assert(!['/features', '/target', '/targetLayout', '/protectedOperations', '/amendment'].some(key => path === key || path.startsWith(`${key}/`)),
      'PLAN_AMENDMENT_PROTECTED_FIELD', `Protected plan field: ${path}`);
  }
  const ids = new Set();
  const paths = new Set();
  for (const doc of scope.documents) {
    assert(doc && typeof doc.id === 'string' && !ids.has(doc.id) && safePath(doc.source?.path)
      && hash(doc.source.sha256) && safePath(doc.outputPath)
      && doc.outputPath.startsWith(`${scope.artifactRoot}/`) && doc.outputPath !== doc.source.path
      && !paths.has(doc.outputPath) && Array.isArray(doc.allowedPointers)
      && Object.keys(doc).every(key => ['id', 'source', 'outputPath', 'allowedPointers'].includes(key)),
    'PLAN_AMENDMENT_DOCUMENT_INVALID', 'Each document requires a distinct immutable source and bounded new output.');
    doc.allowedPointers.forEach(tokens);
    ids.add(doc.id); paths.add(doc.outputPath);
  }
  return scope;
};

export const validateAmendmentGraph = plan => {
  const proposals = plan?.proposedFeatures;
  assert(Array.isArray(proposals) && proposals.length > 0, 'PLAN_AMENDMENT_GRAPH_INVALID', 'A complete proposal graph is required.');
  const keys = new Set(proposals.map(item => `${item.projectId}/${item.id}`));
  assert(keys.size === proposals.length, 'PLAN_AMENDMENT_GRAPH_INVALID', 'Proposal identities must be unique.');
  for (const projectId of new Set(proposals.map(item => item.projectId))) {
    const pending = new Map(proposals.filter(item => item.projectId === projectId).map(item => [item.id, item]));
    const complete = new Set();
    while (pending.size) {
      const ready = [...pending.values()].find(item => Array.isArray(item.dependsOn) && item.dependsOn.every(id => complete.has(id)));
      assert(ready, 'PLAN_AMENDMENT_GRAPH_INVALID', 'Amendment introduces a cycle, missing producer or cross-project dependency.');
      pending.delete(ready.id); complete.add(ready.id);
    }
  }
  return plan;
};

export const rebindAmendmentReferences = (value, documents, reverse = false) => {
  if (typeof value === 'string') {
    for (const doc of documents) {
      const from = reverse ? doc.outputPath : doc.source.path;
      const to = reverse ? doc.source.path : doc.outputPath;
      if (value.startsWith(`${from}#/`)) return to + value.slice(from.length);
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(item => rebindAmendmentReferences(item, documents, reverse));
  if (!value || typeof value !== 'object') return value;
  const doc = documents.find(item => value.path === (reverse ? item.outputPath : item.source.path)
    && value.sha256 === (reverse ? item.resultSha256 : item.source.sha256));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    doc && key === 'path' ? reverse ? doc.source.path : doc.outputPath
      : doc && key === 'sha256' ? reverse ? doc.source.sha256 : doc.resultSha256
      : rebindAmendmentReferences(item, documents, reverse)]));
};

export const amendmentArtifactScope = (scope, patch) => {
  const generation = digestJson({ basePlanDigest: patch.basePlanDigest, changeRequestDigest: patch.changeRequestDigest, changes: patch.changes,
    documents: patch.documents.map(item => ({ id: item.id, changes: item.changes })) });
  const artifactRoot = `${scope.artifactRoot}/${generation}`;
  return { artifactRoot, documents: scope.documents.map(doc => ({ ...doc,
    outputPath: `${artifactRoot}/${doc.outputPath.slice(scope.artifactRoot.length + 1)}` })) };
};

export const applyPlanAmendment = (revision, patch) => {
  const scope = validateAmendmentScope(revision.amendmentScope);
  assert(patch?.version === AMENDMENT_VERSION && patch.basePlanDigest === revision.parentPlanDigest
    && patch.changeRequestDigest === revision.changeRequestDigest
    && Array.isArray(patch.documents) && patch.documents.length === scope.documents.length
    && Object.keys(patch).every(key => ['version', 'basePlanDigest', 'changeRequestDigest', 'changes', 'documents'].includes(key)),
  'PLAN_AMENDMENT_BINDING_MISMATCH', 'Delta must bind the exact approved base and registered change request.');
  const artifacts = amendmentArtifactScope(scope, patch);
  const documents = artifacts.documents.map(doc => {
    const matches = patch.documents.filter(item => item.id === doc.id);
    assert(matches.length === 1 && hash(matches[0].resultSha256)
      && Array.isArray(matches[0].changes)
      && Object.keys(matches[0]).every(key => ['id', 'changes', 'resultSha256'].includes(key)),
    'PLAN_AMENDMENT_DOCUMENT_INVALID', `Missing or duplicated document delta: ${doc.id}`);
    return { ...doc, ...matches[0] };
  });
  const base = revision.parentPlan;
  assert(scope.featureIds.every(id => base.proposedFeatures.some(item => item.id === id)),
    'PLAN_AMENDMENT_SCOPE_VIOLATION', 'An affected Feature is absent from the approved base.');
  assert(Buffer.byteLength(JSON.stringify(patch)) <= 2 * 1024 * 1024,
    'PLAN_AMENDMENT_TOO_LARGE', 'The complete delta exceeds 2 MiB and requires Replan.');
  let next = applyAmendmentChanges(base, patch.changes, scope.planPointers);
  assert(digestJson(base.features) === digestJson(next.features),
  'PLAN_AMENDMENT_IDENTITY_CHANGED', 'Adding, removing or reassigning a proposal requires Replan.');
  const modified = assertAmendmentMembership(base, next, scope);
  next = rebindAmendmentReferences(next, documents);
  validateAmendmentGraph(next);
  const downstream = new Set(scope.featureIds);
  let priorSize;
  do {
    priorSize = downstream.size;
    for (const item of next.proposedFeatures) if (item.dependsOn.some(id => downstream.has(id))) downstream.add(item.id);
  } while (priorSize !== downstream.size);
  return { ...next, readablePlan: `${artifacts.artifactRoot}/changes.md`, amendment: {
    version: AMENDMENT_VERSION, artifactRoot: artifacts.artifactRoot, basePlanDigest: revision.parentPlanDigest,
    changeRequestDigest: revision.changeRequestDigest, deltaDigest: digestJson(patch),
    affectedFeatureIds: [...scope.featureIds], modifiedFeatureIds: modified,
    downstreamFeatureIds: [...downstream],
    deltaRef: { path: `${artifacts.artifactRoot}/amendment.json`, sha256: sha256(`${stringifyAmendmentJson(patch)}\n`) },
    documentBindings: documents.map(doc => ({ id: doc.id, source: doc.source, outputPath: doc.outputPath, resultSha256: doc.resultSha256 })),
  } };
};

export const resolvedPlanAmendment = (revision, value, { workspaceRoot } = {}) => {
  if (value?.deltaRef && !value.plan) {
    const plan = applyPlanAmendment(revision, readAmendmentReference(revision, value, workspaceRoot));
    assert(value.version === AMENDMENT_VERSION && value.basePlanDigest === plan.amendment.basePlanDigest
      && value.changeRequestDigest === plan.amendment.changeRequestDigest
      && digestJson(value.deltaRef) === digestJson(plan.amendment.deltaRef),
    'PLAN_AMENDMENT_BINDING_MISMATCH', 'The compact result must bind the exact reconstructed plan.');
    return plan;
  }
  if (!value?.plan) return applyPlanAmendment(revision, value);
  const scope = validateAmendmentScope(revision.amendmentScope);
  const plan = value.plan;
  const amendment = plan.amendment;
  assert(value.version === AMENDMENT_VERSION && value.basePlanDigest === revision.parentPlanDigest
    && value.changeRequestDigest === revision.changeRequestDigest
    && amendment?.basePlanDigest === value.basePlanDigest && amendment.changeRequestDigest === value.changeRequestDigest
    && digestJson(amendment.deltaRef) === digestJson(value.deltaRef)
    && hash(amendment.deltaDigest) && hash(value.deltaRef?.sha256)
    && value.deltaRef.path.startsWith(`${scope.artifactRoot}/`)
    && digestJson(amendment.affectedFeatureIds) === digestJson(scope.featureIds)
    && Array.isArray(amendment.documentBindings) && amendment.documentBindings.length === scope.documents.length,
  'PLAN_AMENDMENT_BINDING_MISMATCH', 'Resolved plan must retain the exact immutable delta reference and registered affected set.');
  const base = revision.parentPlan;
  assert(digestJson(base.features) === digestJson(plan.features),
  'PLAN_AMENDMENT_IDENTITY_CHANGED', 'Resolved amendment changed proposal identities.');
  assertAmendmentMembership(base, rebindAmendmentReferences(plan, amendment.documentBindings, true), scope);
  for (const [index, item] of base.proposedFeatures.entries()) if (!scope.featureIds.includes(item.id)) {
    assert(digestJson(item) === digestJson(rebindAmendmentReferences(plan.proposedFeatures[index], amendment.documentBindings, true)),
      'PLAN_AMENDMENT_SCOPE_VIOLATION', 'An unaffected resolved proposal changed.');
  }
  return validateAmendmentGraph(plan);
};

export const renderPlanAmendmentDelta = patch => {
  const rows = ['# 局部计划修订差异', '', `原批准计划：${patch.basePlanDigest}`,
    `登记变更：${patch.changeRequestDigest}`, `补丁摘要：${digestJson(patch)}`, '',
    '未列出的原计划内容保持不变；本文件不构成人工批准。', ''];
  for (const document of [{ id: 'typed-plan', changes: patch.changes }, ...patch.documents]) {
    rows.push(`## ${document.id}`, '');
    for (const change of document.changes) rows.push(`### ${change.path}`, '',
      `${change.op === 'add' ? '新增成员；原父值摘要' : '原值摘要'}：${change.expectedDigest}`, '', '```json', stringifyAmendmentJson(change.value), '```', '');
  }
  return `${rows.join('\n')}\n`;
};
