import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digestJson, sha256 } from '../src/common/canonical.mjs';
import { harnessTemporaryRoot } from '../src/common/write-boundary.mjs';
import { applyAmendmentChanges, applyPlanAmendment } from '../src/flows/delivery-lifecycle/plan-amendment.mjs';
import { materializePlanAmendment, planAmendmentReference, readPlanAmendmentScope, resolvePlanAmendmentResult, verifyPlanAmendmentArtifacts } from '../src/application/plan-amendment-artifacts.mjs';
import { deliveryLifecycleProfile } from '../src/flows/delivery-lifecycle/policy/delivery-lifecycle.mjs';
import { planApprovalSnapshot, planApprovalSatisfied } from '../src/flows/delivery-lifecycle/plan-approval.mjs';
import { amendmentFixture } from './fixtures/plan-amendment.mjs';
import { resolveAmendmentWorkflow } from '../src/interfaces/cli/commands/plan-amendment.mjs';
import { loadExtensionPack } from '../src/platform/extensions/contract.mjs';
import { createCardWorldProjectDescriptor } from '../integrations/legacy-consumers/cardworld/index.mjs';

test('bounded delta preserves unrelated proposals and records downstream impact', () => {
  const { parentPlan, revision, patch } = amendmentFixture();
  const base = structuredClone(parentPlan);
  const next = applyPlanAmendment(revision, patch);
  assert.deepEqual(parentPlan, base);
  assert.deepEqual(next.proposedFeatures[0], base.proposedFeatures[0]);
  assert.deepEqual(next.amendment.modifiedFeatureIds, ['A1']);
  assert.deepEqual(next.amendment.downstreamFeatureIds, ['A1', 'A2']);
  assert.equal(next.amendment.deltaDigest, digestJson(patch));
});

test('local amendment inspection resolves the actual Extension-owned engine Workflow', async () => {
  const boundExtension = await loadExtensionPack('./integrations/legacy-consumers/cardworld/index.mjs', { controlRoot: process.cwd() });
  const project = createCardWorldProjectDescriptor({ workspaceRoot: resolve(process.cwd(), '.tmp', 'workflow-shape') });
  assert.equal(project.workflows, undefined);
  assert.equal(resolveAmendmentWorkflow({ project, boundExtension, profileId: 'engine-delivery' }), 'engine-delivery');
  assert.throws(() => resolveAmendmentWorkflow({ project, boundExtension, profileId: 'other' }), { code: 'PLAN_AMENDMENT_WORKFLOW_REQUIRED' });
  assert.throws(() => resolveAmendmentWorkflow({ project, boundExtension, profileId: 'engine-delivery', workflowId: 'other' }), { code: 'PLAN_AMENDMENT_WORKFLOW_REQUIRED' });
});

test('stale bases, scope escape, overlapping pointers and dependency cycles fail closed', () => {
  const { revision, patch } = amendmentFixture();
  assert.throws(() => applyPlanAmendment(revision, { ...patch, basePlanDigest: 'c'.repeat(64) }), { code: 'PLAN_AMENDMENT_BINDING_MISMATCH' });
  const stale = structuredClone(patch); stale.changes[0].expectedDigest = 'c'.repeat(64);
  assert.throws(() => applyPlanAmendment(revision, stale), { code: 'PLAN_AMENDMENT_BASE_STALE' });
  const outside = structuredClone(patch); outside.changes[0].path = '/proposedFeatures/0/contracts';
  assert.throws(() => applyPlanAmendment(revision, outside), { code: 'PLAN_AMENDMENT_SCOPE_VIOLATION' });
  assert.throws(() => applyAmendmentChanges({ a: { b: 1 } }, [
    { path: '/a', expectedDigest: digestJson({ b: 1 }), value: { b: 2 } },
    { path: '/a/b', expectedDigest: digestJson(1), value: 3 },
  ], ['/a']), { code: 'PLAN_AMENDMENT_OVERLAPPING_CHANGES' });
  const cycle = structuredClone(patch);
  cycle.changes.push({ path: '/proposedFeatures/1/dependsOn', expectedDigest: digestJson(['A0']), value: ['A2'] });
  assert.throws(() => applyPlanAmendment(revision, cycle), { code: 'PLAN_AMENDMENT_GRAPH_INVALID' });
  assert.throws(() => applyAmendmentChanges({}, [{ path: '/__proto__/x', expectedDigest: digestJson(null), value: 1 }], ['/__proto__']), { code: 'PLAN_AMENDMENT_POINTER_INVALID' });
});

test('scope bounds still forbid changing proposal identity or final architecture', () => {
  const { revision, patch } = amendmentFixture();
  const id = structuredClone(patch);
  revision.amendmentScope.planPointers.push('/proposedFeatures/1/id');
  id.changes = [{ path: '/proposedFeatures/1/id', expectedDigest: digestJson('A1'), value: 'OTHER' }];
  assert.throws(() => applyPlanAmendment(revision, id), { code: 'PLAN_AMENDMENT_IDENTITY_CHANGED' });
  revision.amendmentScope.planPointers.push('/targetLayout');
  assert.throws(() => applyPlanAmendment(revision, patch), { code: 'PLAN_AMENDMENT_PROTECTED_FIELD' });
});

test('document materialization is reproducible, preserves bases and detects artifact tampering', async t => {
  const root = await mkdtemp(resolve(harnessTemporaryRoot(), 'amendment-artifact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'docs'), { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify({ sourceLifecycleContract: { sources: [{ lastExitFeature: 'A1' }] } }, null, 2)}\n`);
  await writeFile(resolve(root, 'docs/base.json'), bytes);
  const { revision, patch } = amendmentFixture();
  revision.parentPlan.expandedPlan = { path: 'docs/base.json', sha256: sha256(bytes) };
  revision.amendmentScope.documents.push({ id: 'expanded', source: revision.parentPlan.expandedPlan,
    outputPath: 'docs/amend/expanded.json', allowedPointers: ['/sourceLifecycleContract/sources/0/lastExitFeature'] });
  patch.documents.push({ id: 'expanded', changes: [{ path: '/sourceLifecycleContract/sources/0/lastExitFeature', expectedDigest: digestJson('A1'), value: 'A2' }] });
  const built = await materializePlanAmendment({ revision, patch, workspaceRoot: root });
  assert.deepEqual(await readFile(resolve(root, 'docs/base.json')), bytes);
  assert.match(built.plan.expandedPlan.path, /^docs\/amend\/[a-f0-9]{64}\/expanded.json$/);
  assert.deepEqual((await materializePlanAmendment({ revision, patch, workspaceRoot: root })).artifacts, built.artifacts);
  const state = { metadata: { commandIntent: { action: 'amend' }, planRevision: revision } };
  const feature = { metadata: { stage: 'version-planning' }, allowedPaths: ['docs/amend'] };
  const result = { status: 'completed', outputs: { amendment: { value: built.patch } } };
  await verifyPlanAmendmentArtifacts({ state, feature, result, workspaceRoot: root });
  await writeFile(resolve(root, built.plan.expandedPlan.path), '{}');
  await assert.rejects(verifyPlanAmendmentArtifacts({ state, feature, result, workspaceRoot: root }), { code: 'PLAN_AMENDMENT_ARTIFACT_MISMATCH' });
});

test('independent review and human approval bind the exact delta and affected set', () => {
  const { revision, patch } = amendmentFixture();
  const state = { projectId: 'sample', runId: 'amend-run', sourceDigest: 'c'.repeat(64), decisions: [], gates: [],
    metadata: { commandIntent: { action: 'amend', target: 'V1' }, planRevision: revision },
    profile: { config: { requireCanonicalDecision: false, requireUserCodeReview: false, requiredFinalGates: [] } },
    features: [{ id: 'amend', state: 'completed', metadata: { stage: 'version-planning' } },
      { id: 'review', state: 'completed', metadata: { stage: 'plan-review' } }],
    submissions: [{ featureId: 'amend', result: { status: 'completed', outputs: { amendment: { value: patch } } } }],
  };
  const review = { approved: true, findings: [], basePlanDigest: revision.parentPlanDigest,
    deltaDigest: digestJson(patch), reviewedFeatureIds: ['A1', 'A2'] };
  const feature = state.features[1];
  assert.equal(deliveryLifecycleProfile.validateResult({ state, feature,
    result: { status: 'completed', outputs: { 'plan-review': { value: { ...review, deltaDigest: 'd'.repeat(64) } } } } }).ok, false);
  assert.equal(deliveryLifecycleProfile.validateResult({ state, feature,
    result: { status: 'completed', outputs: { 'plan-review': { value: review } } } }).ok, true);
  state.submissions.push({ featureId: 'review', result: { status: 'completed', outputs: { 'plan-review': { value: review } } } });
  const snapshot = planApprovalSnapshot(state);
  assert.match(snapshot.markdown, /局部修订/);
  assert.equal(planApprovalSatisfied(state), false);
  const approval = { id: 'implementation-plan-approved', actor: 'user', decision: 'approved', projectId: state.projectId,
    runId: state.runId, planDigest: snapshot.planDigest, artifactDigest: snapshot.artifactDigest };
  assert.equal(planApprovalSatisfied({ ...state, decisions: [{ ...approval, runId: 'base-plan' }] }), false);
  assert.equal(planApprovalSatisfied({ ...state, decisions: [approval] }), true);
});

test('scope references and original declaration bytes remain hash-pinned', async t => {
  const root = await mkdtemp(resolve(harnessTemporaryRoot(), 'amendment-pins-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'docs'), { recursive: true });
  const { revision, patch } = amendmentFixture();
  const scopeBytes = Buffer.from(JSON.stringify(revision.amendmentScope));
  await writeFile(resolve(root, 'docs/scope.json'), scopeBytes);
  const request = { amendmentScopeRef: { path: 'docs/scope.json', sha256: sha256(scopeBytes) } };
  assert.deepEqual(await readPlanAmendmentScope(request, root), revision.amendmentScope);
  await writeFile(resolve(root, 'docs/scope.json'), '{}');
  await assert.rejects(readPlanAmendmentScope(request, root), { code: 'PLAN_AMENDMENT_INPUT_STALE' });
  const base = { source_symbol: 'source::Record', source_sha256: 'a'.repeat(64), source_declaration: 'struct Record;', deadline: 'A1' };
  const bytes = Buffer.from(JSON.stringify(base));
  await writeFile(resolve(root, 'docs/base.json'), bytes);
  revision.parentPlan.expandedPlan = { path: 'docs/base.json', sha256: sha256(bytes) };
  revision.amendmentScope.documents.push({ id: 'base', source: revision.parentPlan.expandedPlan,
    outputPath: 'docs/amend/base.json', allowedPointers: ['/source_declaration', '/deadline'] });
  patch.documents = [{ id: 'base', changes: [{ path: '/source_declaration', expectedDigest: digestJson(base.source_declaration), value: 'struct Replacement;' }] }];
  await assert.rejects(materializePlanAmendment({ revision, patch, workspaceRoot: root }), { code: 'PLAN_AMENDMENT_SOURCE_IDENTITY_CHANGED' });
});

test('materialization preserves exact integer and decimal tokens while native output stays compact', async t => {
  const root = await mkdtemp(resolve(harnessTemporaryRoot(), 'amendment-numbers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'docs'), { recursive: true });
  const bytes = Buffer.from('{"limit":18446744073709551615,"tiny":0.100000000000000001,"deadline":"A1"}\n');
  await writeFile(resolve(root, 'docs/base.json'), bytes);
  const { revision, patch } = amendmentFixture();
  revision.parentPlan.expandedPlan = { path: 'docs/base.json', sha256: sha256(bytes) };
  revision.amendmentScope.documents.push({ id: 'base', source: revision.parentPlan.expandedPlan,
    outputPath: 'docs/amend/base.json', allowedPointers: ['/deadline'] });
  patch.documents = [{ id: 'base', changes: [{ path: '/deadline', expectedDigest: digestJson('A1'), value: 'A2' }] }];
  const built = await materializePlanAmendment({ revision, patch, workspaceRoot: root });
  const serialized = await readFile(resolve(root, built.plan.expandedPlan.path), 'utf8');
  assert.match(serialized, /18446744073709551615/);
  assert.match(serialized, /0\.100000000000000001/);
  assert.deepEqual(await readFile(resolve(root, 'docs/base.json')), bytes);
  const reference = planAmendmentReference(built);
  assert(Buffer.byteLength(JSON.stringify(reference)) < 1024);
  const state = { metadata: { commandIntent: { action: 'amend' }, planRevision: revision } };
  const feature = { metadata: { stage: 'version-planning' }, allowedPaths: ['docs/amend'] };
  const result = { status: 'completed', outputs: { amendment: { value: reference } } };
  const resolved = await resolvePlanAmendmentResult({ state, feature, result, workspaceRoot: root });
  assert.equal(result.outputs.amendment.value.plan, undefined);
  assert(resolved.result.outputs.amendment.value.plan);
  await verifyPlanAmendmentArtifacts({ state, feature, result: resolved.result, workspaceRoot: root });
  await assert.rejects(resolvePlanAmendmentResult({ state, feature, result: resolved.result, workspaceRoot: root }),
    { code: 'PLAN_AMENDMENT_FULL_REWRITE_DENIED' });
  const bad = structuredClone(result); bad.outputs.amendment.value.deltaRef.sha256 = 'd'.repeat(64);
  await assert.rejects(resolvePlanAmendmentResult({ state, feature, result: bad, workspaceRoot: root }),
    { code: 'PLAN_AMENDMENT_INPUT_STALE' });
});
