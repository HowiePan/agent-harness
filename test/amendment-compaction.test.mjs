import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digestJson, sha256 } from '../src/common/canonical.mjs';
import { harnessTemporaryRoot } from '../src/common/write-boundary.mjs';
import { compactAmendmentChanges } from '../src/flows/delivery-lifecycle/amendment-compaction.mjs';
import { digestAmendmentJson, parseAmendmentJson, stringifyAmendmentJson } from '../src/flows/delivery-lifecycle/amendment-json.mjs';
import { applyAmendmentChanges, applyPlanAmendment } from '../src/flows/delivery-lifecycle/plan-amendment.mjs';
import { compactPlanAmendmentDelta, buildPlanAmendmentArtifacts, materializePlanAmendment,
  planAmendmentReference, verifyPlanAmendmentArtifacts } from '../src/application/plan-amendment-artifacts.mjs';
import { amendmentFixture } from './fixtures/plan-amendment.mjs';

test('absent members and ordered array tails pin the original parent without modifying it', () => {
  const base = { object: { kept: 1 }, array: ['original'] };
  const changes = [
    { op: 'add', path: '/object/a~1b~0c', expectedDigest: digestJson(base.object), value: null },
    { op: 'add', path: '/array/1', expectedDigest: digestJson(base.array), value: 'one' },
    { op: 'add', path: '/array/2', expectedDigest: digestJson(base.array), value: 'two' },
  ];
  assert.deepEqual(applyAmendmentChanges(base, changes, ['/object', '/array']),
    { object: { kept: 1, 'a/b~c': null }, array: ['original', 'one', 'two'] });
  assert.deepEqual(base, { object: { kept: 1 }, array: ['original'] });
  for (const [change, code] of [
    [{ ...changes[0], path: '/object/kept' }, 'PLAN_AMENDMENT_ADD_INVALID'],
    [{ ...changes[0], expectedDigest: 'a'.repeat(64) }, 'PLAN_AMENDMENT_BASE_STALE'],
    [{ ...changes[0], path: '/elsewhere/x' }, 'PLAN_AMENDMENT_SCOPE_VIOLATION'],
    [{ ...changes[0], path: '/object/__proto__' }, 'PLAN_AMENDMENT_POINTER_INVALID'],
    [{ ...changes[1], path: '/array/0' }, 'PLAN_AMENDMENT_ADD_INVALID'],
    [{ ...changes[1], path: '/array/2' }, 'PLAN_AMENDMENT_ADD_INVALID'],
    [{ ...changes[1], path: '/array/01' }, 'PLAN_AMENDMENT_ADD_INVALID'],
    [{ ...changes[1], path: '/array/-' }, 'PLAN_AMENDMENT_ADD_INVALID'],
    [{ ...changes[1], op: 'remove' }, 'PLAN_AMENDMENT_SCOPE_VIOLATION'],
  ]) assert.throws(() => applyAmendmentChanges(base, [change], ['/object', '/array']), { code });
  assert.throws(() => applyAmendmentChanges(base, [changes[0], changes[0]], ['/object']),
    { code: 'PLAN_AMENDMENT_OVERLAPPING_CHANGES' });
  assert.throws(() => applyAmendmentChanges(base, [
    { path: '/object', expectedDigest: digestJson(base.object), value: { kept: 2 } }, changes[0],
  ], ['/object']), { code: 'PLAN_AMENDMENT_OVERLAPPING_CHANGES' });
  const { revision, patch } = amendmentFixture();
  revision.amendmentScope.planPointers = ['/proposedFeatures'];
  patch.changes = [{ op: 'add', path: '/proposedFeatures/3', expectedDigest: digestJson(revision.parentPlan.proposedFeatures),
    value: { ...revision.parentPlan.proposedFeatures[1], id: 'unregistered', splitFrom: 'A1' } }];
  assert.throws(() => applyPlanAmendment(revision, patch), { code: 'PLAN_AMENDMENT_SPLIT_SCOPE_VIOLATION' });
});

test('compaction preserves exact integer/decimal tokens and remains idempotent', () => {
  const base = parseAmendmentJson('{"rows":[{"kept":"' + 'x'.repeat(20000)
    + '","n":18446744073709551615,"d":0.100000000000000001}]}');
  const next = structuredClone(base.rows);
  next[0].newField = 'new';
  next.push(parseAmendmentJson('{"n":18446744073709551614}'));
  const changes = [{ path: '/rows', expectedDigest: digestAmendmentJson(base.rows), value: next }];
  const compact = compactAmendmentChanges(base, changes, ['/rows']);
  assert(compact.every(row => row.op === 'add'));
  assert.deepEqual(compactAmendmentChanges(base, compact, ['/rows']), compact);
  assert.equal(stringifyAmendmentJson(applyAmendmentChanges(base, compact, ['/rows'])),
    stringifyAmendmentJson({ rows: next }));
  const numeric = [{ path: '/rows/0/n', expectedDigest: digestAmendmentJson(base.rows[0].n), value: next[1].n }];
  assert.deepEqual(compactAmendmentChanges(base, numeric, ['/rows']), numeric);
  assert(!JSON.stringify(compact).includes('$harness.exact-plan-number/newField'));
});

test('large repeated preimages compact through official artifacts while both size guards remain', async t => {
  const root = await mkdtemp(resolve(harnessTemporaryRoot(), 'amendment-compaction-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'docs'), { recursive: true });
  const { revision, patch } = amendmentFixture();
  revision.parentPlan.proposedFeatures[0].contracts = ['unchanged'.repeat(80000)];
  revision.parentPlan.proposedFeatures[1].contracts = ['preserved'.repeat(80000)];
  revision.amendmentScope.planPointers = ['/proposedFeatures'];
  const base = { proposedFeatures: structuredClone(revision.parentPlan.proposedFeatures) };
  const original = Buffer.from(stringifyAmendmentJson(base) + '\n');
  await writeFile(resolve(root, 'docs/base.json'), original);
  revision.parentPlan.expandedPlan = { path: 'docs/base.json', sha256: sha256(original) };
  revision.amendmentScope.documents = [{ id: 'expanded', source: revision.parentPlan.expandedPlan,
    outputPath: 'docs/amend/expanded.json', allowedPointers: ['/proposedFeatures'] }];
  const updated = structuredClone(base.proposedFeatures);
  updated[1].deliveryNote = 'preserve the entire original contract';
  patch.changes = [{ path: '/proposedFeatures', expectedDigest: digestAmendmentJson(base.proposedFeatures), value: updated }];
  patch.documents = [{ id: 'expanded', resultSha256: '0'.repeat(64), changes: structuredClone(patch.changes) }];
  assert(Buffer.byteLength(JSON.stringify(patch)) > 2 * 1024 * 1024);
  assert.throws(() => applyPlanAmendment(revision, patch), { code: 'PLAN_AMENDMENT_TOO_LARGE' });
  const compact = await compactPlanAmendmentDelta({ revision, patch, workspaceRoot: root });
  assert(Buffer.byteLength(JSON.stringify(compact)) < 2000);
  const input = { revision, patch: compact, workspaceRoot: root };
  const built = await materializePlanAmendment(input);
  assert.deepEqual(await readFile(resolve(root, 'docs/base.json')), original);
  assert.deepEqual(built.plan.proposedFeatures, updated);
  assert.deepEqual((await buildPlanAmendmentArtifacts(input)).patch, built.patch);
  const state = { metadata: { commandIntent: { action: 'amend' }, planRevision: revision } };
  const feature = { metadata: { stage: 'version-planning' }, allowedPaths: ['docs/amend'] };
  const result = { status: 'completed', outputs: { amendment: { value: planAmendmentReference(built) } } };
  await verifyPlanAmendmentArtifacts({ state, feature, result, workspaceRoot: root });
  assert.throws(() => applyAmendmentChanges({}, [{ op: 'add', path: '/payload', expectedDigest: digestJson({}),
    value: 'z'.repeat(2 * 1024 * 1024) }], ['/payload']), { code: 'PLAN_AMENDMENT_TOO_LARGE' });
  const stale = structuredClone(compact); stale.changes[0].expectedDigest = 'a'.repeat(64);
  assert.throws(() => applyPlanAmendment(revision, stale), { code: 'PLAN_AMENDMENT_BASE_STALE' });
  await writeFile(resolve(root, built.plan.expandedPlan.path), '{}');
  await assert.rejects(verifyPlanAmendmentArtifacts({ state, feature, result, workspaceRoot: root }),
    { code: 'PLAN_AMENDMENT_ARTIFACT_MISMATCH' });
});
