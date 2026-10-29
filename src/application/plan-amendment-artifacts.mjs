import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { assert } from '../common/errors.mjs';
import { buildImplementationContinuation } from './implementation-continuation.mjs';
import { DELIVERY_BATCH_POLICY } from '../flows/delivery-lifecycle/delivery-batches.mjs';
import { digestJson, sha256 } from '../common/canonical.mjs';
import { assertNoLinkPath } from '../common/paths.mjs';
import { parseAmendmentJson, stringifyAmendmentJson } from '../flows/delivery-lifecycle/amendment-json.mjs';
import { assertAmendmentMembership } from '../flows/delivery-lifecycle/amendment-feature-splits.mjs';
import { compactAmendmentChanges } from '../flows/delivery-lifecycle/amendment-compaction.mjs';
import { amendmentArtifactScope, applyAmendmentChanges, applyPlanAmendment, readAmendmentPointer,
  rebindAmendmentReferences, renderPlanAmendmentDelta, validateAmendmentGraph, validateAmendmentScope } from '../flows/delivery-lifecycle/plan-amendment.mjs';

const jsonBytes = value => Buffer.from(`${stringifyAmendmentJson(value)}\n`);
const frozenKeys = new Set(['source_symbol', 'source_sha256', 'sourceSha256', 'source_declaration',
  'complete_source_members', 'sourcePath', 'source_path']);
const containsFrozenSource = value => value && typeof value === 'object'
  && Object.entries(value).some(([key, item]) => frozenKeys.has(key) || containsFrozenSource(item));
const assertFrozenSources = (base, next) => {
  if (!base || typeof base !== 'object') return;
  if (!next || typeof next !== 'object') {
    assert(!containsFrozenSource(base), 'PLAN_AMENDMENT_SOURCE_IDENTITY_CHANGED', 'A frozen source declaration was removed.');
    return;
  }
  for (const [key, value] of Object.entries(base)) {
    if (frozenKeys.has(key)) assert(next && Object.hasOwn(next, key) && digestJson(value) === digestJson(next[key]),
      'PLAN_AMENDMENT_SOURCE_IDENTITY_CHANGED', `Frozen original source identity changed: ${key}`);
    else assertFrozenSources(value, next[key]);
  }
};
const readPinned = async (root, ref) => {
  const path = assertNoLinkPath(root, resolve(root, ref.path), 'amendment input');
  assert((await stat(path)).size <= 128 * 1024 * 1024,
    'PLAN_AMENDMENT_INPUT_TOO_LARGE', 'Amendment input exceeds 128 MiB.');
  const bytes = await readFile(path);
  assert(sha256(bytes) === ref.sha256, 'PLAN_AMENDMENT_INPUT_STALE', `Pinned input changed: ${ref.path}`);
  return parseAmendmentJson(bytes.toString('utf8').replace(/^\uFEFF/, ''));
};

export const readPlanAmendmentScope = async (request, workspaceRoot) => {
  assert(Boolean(request?.amendmentScope) !== Boolean(request?.amendmentScopeRef),
    'PLAN_AMENDMENT_SCOPE_REQUIRED', 'Register exactly one inline scope or hash-pinned scope reference.');
  const scope = request.amendmentScopeRef
    ? await readPinned(workspaceRoot, request.amendmentScopeRef) : request.amendmentScope;
  return validateAmendmentScope(scope);
};

export const assertAmendmentDocumentPins = (revision) => {
  const refs = Object.values(revision.parentPlan).filter(value => value && typeof value === 'object' && value.path && value.sha256);
  for (const doc of revision.amendmentScope.documents) assert(refs.some(ref => ref.path === doc.source.path && ref.sha256 === doc.source.sha256),
    'PLAN_AMENDMENT_INPUT_UNAPPROVED', 'Each document must be an active root input pinned by the approved base, not an ancestor reference.');
};

/** Opt-in syntax compaction only; materialization still runs every original guard. */
export const compactPlanAmendmentDelta = async ({ revision, patch, workspaceRoot }) => {
  const scope = validateAmendmentScope(revision.amendmentScope);
  assertAmendmentDocumentPins(revision);
  assert(Array.isArray(patch?.documents) && patch.documents.length === scope.documents.length,
    'PLAN_AMENDMENT_DOCUMENT_INVALID', 'Compaction requires every registered pinned document.');
  const compact = structuredClone(patch);
  compact.changes = compactAmendmentChanges(revision.parentPlan, patch.changes, scope.planPointers);
  for (const spec of scope.documents) {
    const entries = compact.documents.filter(row => row.id === spec.id);
    assert(entries.length === 1, 'PLAN_AMENDMENT_DOCUMENT_INVALID', 'Missing or duplicated document delta.');
    const base = await readPinned(workspaceRoot, spec.source);
    entries[0].changes = compactAmendmentChanges(base, entries[0].changes, spec.allowedPointers);
  }
  return compact;
};

export const planAmendmentReference = built => ({ version: 'plan-amendment/1',
  basePlanDigest: built.plan.amendment.basePlanDigest,
  changeRequestDigest: built.plan.amendment.changeRequestDigest, deltaRef: built.plan.amendment.deltaRef });

const readDelta = async (value, revision, workspaceRoot) => {
  if (!value?.deltaRef) return value;
  assert(value.deltaRef.path.startsWith(`${revision.amendmentScope.artifactRoot}/`),
    'PLAN_AMENDMENT_SCOPE_VIOLATION', 'Delta reference is outside the registered artifact root.');
  return readPinned(workspaceRoot, value.deltaRef);
};

/** Preserve the exact native compact result and derive only digest-checked typed data. */
export const resolvePlanAmendmentResult = async ({ state, feature, result, workspaceRoot }) => {
  if (state.metadata?.commandIntent?.action !== 'amend' || feature.metadata?.stage !== 'version-planning'
    || result.status !== 'completed') return { result, receipt: null };
  const value = result.outputs?.amendment?.value;
  assert(!value?.plan, 'PLAN_AMENDMENT_FULL_REWRITE_DENIED', 'An Agent cannot provide the machine-derived plan.');
  const revision = state.metadata.planRevision;
  const patch = await readDelta(value, revision, workspaceRoot);
  const built = await buildPlanAmendmentArtifacts({ revision, patch, workspaceRoot });
  const reference = planAmendmentReference(built);
  if (value.deltaRef) assert(digestJson(reference) === digestJson(value),
    'PLAN_AMENDMENT_BINDING_MISMATCH', 'Compact result does not bind the exact materialized delta.');
  const resolved = { ...result, outputs: { ...result.outputs,
    amendment: { ...result.outputs.amendment, value: reference } } };
  return { result: resolved, receipt: { kind: 'plan-amendment-reference-resolution', version: '1.0',
    nativeResultDigest: digestJson(result), resolvedResultDigest: digestJson(resolved),
    deltaRef: reference.deltaRef, deltaDigest: built.plan.amendment.deltaDigest,
    materializedPlanDigest: digestJson(built.plan) } };
};

/** Compute all artifacts before writing; output bytes are deterministic and never replace a base file. */
export const buildPlanAmendmentArtifacts = async ({ revision, patch, workspaceRoot }) => {
  const scope = validateAmendmentScope(revision.amendmentScope);
  assertAmendmentDocumentPins(revision);
  assert(Array.isArray(patch?.documents) && patch.documents.length === scope.documents.length,
    'PLAN_AMENDMENT_DOCUMENT_INVALID', 'The delta must account for every registered document.');
  const outputs = [];
  const rebindings = [];
  const completedPatch = structuredClone(patch);
  const artifacts = amendmentArtifactScope(scope, patch);
  for (const spec of artifacts.documents) {
    const entries = completedPatch.documents.filter(item => item.id === spec.id);
    assert(entries.length === 1, 'PLAN_AMENDMENT_DOCUMENT_INVALID', `Missing/duplicate document: ${spec.id}`);
    const entry = entries[0];
    const base = await readPinned(workspaceRoot, spec.source);
    let value = applyAmendmentChanges(base, entry.changes, spec.allowedPointers);
    assertFrozenSources(base, value);
    for (const key of ['target', 'targetLayout', 'protectedOperations']) {
      assert(digestJson(base[key] ?? null) === digestJson(value[key] ?? null),
        'PLAN_AMENDMENT_PROTECTED_FIELD', `Amendment cannot change ${key}.`);
    }
    if (base.proposedFeatures) {
      assertAmendmentMembership(base, value, scope);
      validateAmendmentGraph(value);
    }
    value = rebindAmendmentReferences(value, rebindings);
    const bytes = jsonBytes(value);
    entry.resultSha256 = sha256(bytes);
    outputs.push({ id: spec.id, path: spec.outputPath, bytes, value });
    rebindings.push({ ...spec, resultSha256: entry.resultSha256 });
  }
  assert(completedPatch.changes.length + completedPatch.documents.reduce((n, item) => n + item.changes.length, 0) > 0,
    'PLAN_AMENDMENT_EMPTY', 'An empty delta is not a plan amendment.');
  const plan = applyPlanAmendment(revision, completedPatch);
  const referenced = new Map(outputs.map(output => [output.path, output.value]));
  const checkReferences = value => {
    if (typeof value === 'string') {
      const [path, pointer] = value.split('#');
      if (referenced.has(path) && pointer) readAmendmentPointer(referenced.get(path), pointer);
    } else if (Array.isArray(value)) value.forEach(checkReferences);
    else if (value && typeof value === 'object') {
      if (referenced.has(value.path) && value.sha256) {
        assert(outputs.find(output => output.path === value.path).bytes
          && value.sha256 === sha256(outputs.find(output => output.path === value.path).bytes),
        'PLAN_AMENDMENT_REFERENCE_STALE', 'A generated document hash is stale.');
      }
      Object.values(value).forEach(checkReferences);
    }
  };
  checkReferences(plan);
  outputs.forEach(output => checkReferences(output.value));
  for (const proposal of plan.proposedFeatures.filter(item => item.disposition === 'project-owned'
    && item.deliveryPolicy === DELIVERY_BATCH_POLICY)) {
    await buildImplementationContinuation({ features: [], submissions: [], attempts: {} }, {
      id: proposal.id, logicalRoot: proposal.id, allowedPaths: proposal.allowedPaths,
      forbiddenPaths: proposal.forbiddenPaths, metadata: { stage: 'implementation', approvedProposal: proposal,
        approvedDeliveryPlan: plan } }, workspaceRoot, { readPinnedBytes: async ref =>
      outputs.find(item => item.path === ref.path)?.bytes
        ?? await readFile(assertNoLinkPath(workspaceRoot, resolve(workspaceRoot, ref.path), 'planned delivery input')) });
  }
  return { plan, patch: completedPatch, outputs, artifactRoot: artifacts.artifactRoot };
};

export const materializePlanAmendment = async input => {
  const built = await buildPlanAmendmentArtifacts(input);
  const root = input.workspaceRoot;
  const artifactRoot = built.artifactRoot;
  const outputs = [...built.outputs,
    { path: `${artifactRoot}/changes.md`, bytes: Buffer.from(renderPlanAmendmentDelta(built.patch)) },
    { path: `${artifactRoot}/amendment.json`, bytes: jsonBytes(built.patch) },
    { path: `${artifactRoot}/plan.json`, bytes: jsonBytes(built.plan) }];
  for (const output of outputs) {
    const path = assertNoLinkPath(root, resolve(root, output.path), 'amendment output');
    let existing = null;
    try { existing = await readFile(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert(existing === null || sha256(existing) === sha256(output.bytes),
      'PLAN_AMENDMENT_OUTPUT_CONFLICT', `Preserve existing amendment artifact: ${output.path}`);
  }
  for (const output of outputs) {
    const path = assertNoLinkPath(root, resolve(root, output.path), 'amendment output');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, output.bytes);
  }
  return { patch: built.patch, plan: built.plan,
    artifacts: outputs.map(output => ({ path: output.path, sha256: sha256(output.bytes) })) };
};

/** Recompute from the immutable inputs; an Agent-provided complete plan is never trusted. */
export const verifyPlanAmendmentArtifacts = async ({ state, feature, result, workspaceRoot }) => {
  if (state.metadata?.commandIntent?.action !== 'amend' || feature.metadata?.stage !== 'version-planning'
    || result.status !== 'completed') return;
  const value = result.outputs?.amendment?.value;
  const patch = await readDelta(value, state.metadata.planRevision, workspaceRoot);
  const built = await buildPlanAmendmentArtifacts({ revision: state.metadata.planRevision, patch, workspaceRoot });
  assert(digestJson(patch) === digestJson(built.patch), 'PLAN_AMENDMENT_REFERENCE_STALE', 'Reported delta differs from deterministic materialization.');
  if (value.plan) assert(digestJson(value.plan) === digestJson(built.plan),
    'PLAN_AMENDMENT_ARTIFACT_MISMATCH', 'Stored materialized plan differs from its immutable delta.');
  const artifacts = [...built.outputs,
    { path: `${built.artifactRoot}/changes.md`, bytes: Buffer.from(renderPlanAmendmentDelta(built.patch)) },
    { path: `${built.artifactRoot}/amendment.json`, bytes: jsonBytes(built.patch) },
    { path: `${built.artifactRoot}/plan.json`, bytes: jsonBytes(built.plan) }];
  for (const artifact of artifacts) {
    assert(feature.allowedPaths.some(path => artifact.path === path || artifact.path.startsWith(`${path}/`)),
      'PLAN_AMENDMENT_SCOPE_VIOLATION', 'Generated artifacts must stay inside the Dispatch allowlist.');
    const path = assertNoLinkPath(workspaceRoot, resolve(workspaceRoot, artifact.path), 'amendment artifact');
    assert(sha256(await readFile(path)) === sha256(artifact.bytes),
      'PLAN_AMENDMENT_ARTIFACT_MISMATCH', `Generated artifact differs from the delta: ${artifact.path}`);
  }
};
