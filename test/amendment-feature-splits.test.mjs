import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digestJson, sha256 } from '../src/common/canonical.mjs';
import { harnessTemporaryRoot } from '../src/common/write-boundary.mjs';
import { applyPlanAmendment, resolvedPlanAmendment, validateAmendmentScope } from '../src/flows/delivery-lifecycle/plan-amendment.mjs';
import { materializePlanAmendment, planAmendmentReference } from '../src/application/plan-amendment-artifacts.mjs';
import { amendmentFixture } from './fixtures/plan-amendment.mjs';

const batch = () => ({ id: 'delivery', objective: 'Implement receiver and prove its behavior', acceptance: ['authored receiver and inverse'],
  verification: ['focused behavior check'], sizing: { basis: 'One connected receiver and its proof', reserve: 'Includes repair and final evidence audit' } });
const fixture = () => {
  const f = amendmentFixture();
  f.revision.amendmentScope.featureSplits = [{ featureId: 'A1', prefix: 'A1-', maxNewFeatures: 2 }];
  f.revision.amendmentScope.batchPolicy = { maxBatchesPerFeature: 20 };
  f.revision.amendmentScope.planPointers = ['/proposedFeatures'];
  const next = structuredClone(f.parentPlan.proposedFeatures);
  next[1].dependsOn.push('A1-receiver');
  next[1].deliveryBatches = [batch()]; next[2].deliveryBatches = [batch()];
  next.push({ ...structuredClone(f.parentPlan.proposedFeatures[1]), id: 'A1-receiver', splitFrom: 'A1',
    contracts: ['receiver behavior'], deliveryBatches: [batch()] });
  f.patch.changes = [{ path: '/proposedFeatures', expectedDigest: digestJson(f.parentPlan.proposedFeatures), value: next }];
  return f;
};

test('explicit bounded split preserves convergence, complete original acceptance and batch sizing', () => {
  const { revision, patch } = fixture();
  const next = applyPlanAmendment(revision, patch);
  assert.deepEqual(next.features, revision.parentPlan.features);
  assert.equal(next.proposedFeatures.length, 4);
  assert.deepEqual(next.proposedFeatures[1].contracts, ['runtime']);
  assert.deepEqual(next.amendment.modifiedFeatureIds, ['A1', 'A2', 'A1-receiver']);
  assert.deepEqual(resolvedPlanAmendment(revision, { ...planAmendmentReference({ plan: next }), plan: next }), next);
});

test('split scope cannot rename originals, expand writes, drop checks or omit prerequisites', () => {
  const cases = [
    [f => { delete f.revision.amendmentScope.featureSplits; }, 'PLAN_AMENDMENT_SPLIT_SCOPE_VIOLATION'],
    [f => { f.patch.changes[0].value[0].id = 'renamed'; }, 'PLAN_AMENDMENT_IDENTITY_CHANGED'],
    [f => { f.patch.changes[0].value[0].contracts = []; }, 'PLAN_AMENDMENT_SCOPE_VIOLATION'],
    [f => { f.patch.changes[0].value[1].contracts = []; }, 'PLAN_AMENDMENT_SPLIT_ACCEPTANCE'],
    [f => { f.patch.changes[0].value[1].dependsOn = ['A0']; }, 'PLAN_AMENDMENT_SPLIT_DEPENDENCY'],
    [f => { f.patch.changes[0].value[3].dependsOn = []; }, 'PLAN_AMENDMENT_SPLIT_DEPENDENCY'],
    [f => { f.patch.changes[0].value[3].allowedPaths = ['other']; }, 'PLAN_AMENDMENT_SPLIT_PATHS'],
    [f => { f.patch.changes[0].value[3].projectId = 'other'; }, 'PLAN_AMENDMENT_SPLIT_SCOPE_VIOLATION'],
    [f => { f.patch.changes[0].value[3].splitFrom = 'A2'; }, 'PLAN_AMENDMENT_SPLIT_SCOPE_VIOLATION'],
    [f => { f.patch.changes[0].value[3].deliveryBatches = Array.from({ length: 21 }, (_, i) => ({ ...batch(), id: String(i) })); }, 'PLAN_AMENDMENT_BATCH_PLAN_REQUIRED'],
    [f => { delete f.patch.changes[0].value[3].deliveryBatches[0].sizing; }, 'PLAN_AMENDMENT_BATCH_PLAN_REQUIRED'],
  ];
  for (const [mutate, code] of cases) { const f = fixture(); mutate(f); assert.throws(() => applyPlanAmendment(f.revision, f.patch), { code }); }
  const f = fixture(); f.revision.amendmentScope.featureSplits[0].prefix = 'any';
  assert.throws(() => validateAmendmentScope(f.revision.amendmentScope), { code: 'PLAN_AMENDMENT_SPLIT_SCOPE_INVALID' });
});

test('typed and expanded append-only splits materialize without rewriting their immutable source', async t => {
  const root = await mkdtemp(resolve(harnessTemporaryRoot(), 'amend-split-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'docs'), { recursive: true });
  const f = fixture(); const bytes = Buffer.from(JSON.stringify(f.parentPlan));
  await writeFile(resolve(root, 'docs/base.json'), bytes);
  f.revision.parentPlan.expandedPlan = { path: 'docs/base.json', sha256: sha256(bytes) };
  f.revision.amendmentScope.documents = [{ id: 'expanded', source: f.revision.parentPlan.expandedPlan,
    outputPath: 'docs/amend/expanded.json', allowedPointers: ['/proposedFeatures'] }];
  f.patch.documents = [{ id: 'expanded', changes: structuredClone(f.patch.changes) }];
  const built = await materializePlanAmendment({ ...f, workspaceRoot: root });
  assert.deepEqual(await readFile(resolve(root, 'docs/base.json')), bytes);
  assert.equal(built.plan.proposedFeatures[3].splitFrom, 'A1');
  const expanded = JSON.parse(await readFile(resolve(root, built.plan.expandedPlan.path), 'utf8'));
  assert.deepEqual(expanded.proposedFeatures, built.plan.proposedFeatures);
});
