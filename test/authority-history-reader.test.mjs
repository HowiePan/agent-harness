import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AuthorityStore } from '../src/kernel/authority-store.mjs';
import { atomicWriteJson } from '../src/kernel/atomic-io.mjs';
import { harnessProjectRoot } from '../src/common/write-boundary.mjs';
import { readVerifiedRunHistory } from '../src/application/authority-history-reader.mjs';
import { digestJson } from '../src/common/canonical.mjs';
import { readPlanRevisionHistory } from '../src/application/plan-revision-history.mjs';
import { planApprovalSnapshot } from '../src/flows/delivery-lifecycle/plan-approval.mjs';
import { selectPlanRevisionParent, preparePlanRevisionIntent } from '../src/application/plan-revision.mjs';
import { amendmentFixture } from './fixtures/plan-amendment.mjs';

test('history reader preserves every verified value, ordering and separate mutable objects', async t => {
  const controlRoot = harnessProjectRoot();
  const root = resolve(controlRoot, '.tmp', `history-reader-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new AuthorityStore({ root, controlRoot });
  const contract = 'Repeated immutable contract. '.repeat(100);
  for (const id of ['a', 'b']) await store.create({ projectId: 'sample', runId: id, status: 'ready',
    metadata: { contracts: [contract], nested: { value: contract } } }, { commandId: id });
  const before = await store.list('sample');
  const after = await readVerifiedRunHistory(store, 'sample');
  assert.deepEqual(after, before);
  assert.deepEqual(after.map(digestJson), before.map(digestJson));
  after[0].metadata.contracts.push('local edit');
  assert.equal(after[1].metadata.contracts.length, 1);
  assert.deepEqual(await store.list('sample'), before);
  const tampered = { ...before[0], status: 'changed' };
  await atomicWriteJson(store.runFile('sample', tampered.runId), tampered, { root });
  await assert.rejects(readVerifiedRunHistory(store, 'sample'), { code: 'AUTHORITY_DIGEST_MISMATCH' });
});

test('missing histories and store adapters keep existing read semantics', async t => {
  const controlRoot = harnessProjectRoot();
  const root = resolve(controlRoot, '.tmp', `history-absent-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await readVerifiedRunHistory(new AuthorityStore({ root, controlRoot }), 'missing'), []);
  const fixture = [{ id: 'a', nested: ['same'.repeat(100)] }, { id: 'b', nested: ['same'.repeat(100)] }];
  const adapter = { list: async id => { assert.equal(id, 'sample'); return structuredClone(fixture); } };
  assert.deepEqual(await readVerifiedRunHistory(adapter, 'sample'), fixture);
});

test('revision history keeps exact selected ancestry and every blocker while discarding unrelated payloads', async t => {
  const controlRoot = harnessProjectRoot();
  const root = resolve(controlRoot, '.tmp', `revision-history-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new AuthorityStore({ root, controlRoot });
  const { revision } = amendmentFixture();
  const intent = { action: 'amend', target: 'V1', workflowId: 'delivery', selector: 'boundary' };
  const common = { projectId: 'sample', sourceDigest: 'source', leases: [], dispatches: [], findings: [], decisions: [] };
  const base = { ...common, runId: 'base', status: 'closed', metadata: { commandIntent: { ...intent, action: 'plan' } },
    features: [{ id: 'plan', state: 'completed', metadata: { stage: 'version-planning' } },
      { id: 'review', state: 'completed', metadata: { stage: 'plan-review' } }],
    submissions: [{ featureId: 'plan', result: { status: 'completed', outputs: { plan: { value: revision.parentPlan } } } },
      { featureId: 'review', result: { status: 'completed', outputs: { 'plan-review': { value: { approved: true, findings: [] } } } } }] };
  const snapshot = planApprovalSnapshot(base);
  base.decisions = [{ id: 'implementation-plan-approved', actor: 'test-user', decision: 'approved', runId: 'base',
    projectId: 'sample', planDigest: snapshot.planDigest, artifactDigest: snapshot.artifactDigest }];
  await store.create(base, { commandId: 'base' });
  const request = { target: 'V1', kind: 'dependency', summary: 'Bounded correction', requirements: ['Keep obligations'],
    acceptance: ['Verify consumers'], amendmentScope: revision.amendmentScope };
  const project = { id: 'sample', policy: { planChangeRequests: { boundary: request } } };
  const planner = { id: 'planner', state: 'blocked', allowedPaths: ['docs/amend'], metadata: { stage: 'version-planning' },
    blocker: { kind: 'scope' } };
  const prior = { ...common, runId: 'previous', status: 'superseded',
    metadata: { commandIntent: intent, planRevision: { parentRunId: 'base' }, audit: 'Exact inherited audit' },
    features: [planner], submissions: [] };
  await store.create(prior, { commandId: 'previous' });
  const draft = { ...common, runId: 'draft', status: 'ready', features: [planner],
    submissions: [{ result: { status: 'blocked', failureClass: 'scope-blocker' } }],
    metadata: { commandIntent: intent, planRevision: { ...revision, parentRunId: 'base', parentPlanDigest: snapshot.planDigest,
      changeRequestDigest: digestJson(request), replacesAmendment: { runId: 'previous' } } } };
  await store.create(draft, { commandId: 'draft' });
  await store.create({ ...common, runId: 'failed-implementation', status: 'failed', features: [
    { id: 'impl', state: 'blocked', metadata: { stage: 'implementation' } }], submissions: [],
  metadata: { commandIntent: { ...intent, action: 'implement' }, workflow: { id: 'delivery' } } }, { commandId: 'failed' });
  await store.create({ ...base, runId: 'unrelated', metadata: { commandIntent: { ...intent, target: 'V0' },
    largePayload: 'Unrelated contract '.repeat(10000) } }, { commandId: 'unrelated' });
  const all = await store.list('sample');
  const selected = await readPlanRevisionHistory(store, 'sample', intent);
  assert.deepEqual(selected.find(row => row.runId === 'base'), all.find(row => row.runId === 'base'));
  assert.deepEqual(selected.find(row => row.runId === 'previous'), all.find(row => row.runId === 'previous'));
  assert.equal(selected.find(row => row.runId === 'unrelated').metadata.largePayload, undefined);
  assert.equal(selectPlanRevisionParent({ intent, states: selected }).runId, selectPlanRevisionParent({ intent, states: all }).runId);
  const prepare = states => preparePlanRevisionIntent({ intent, project, states, sourceDigest: 'source', amendmentScope: request.amendmentScope });
  assert.deepEqual(prepare(selected), prepare(all));
  const failed = await store.read('sample', 'failed-implementation');
  await store.transact('sample', failed.runId, { expectedRevision: failed.revision, commandId: 'open-finding', payload: {} }, state => {
    state.findings.push({ id: 'unresolved', status: 'open' }); return {};
  });
  await assert.rejects(async () => prepare(await readPlanRevisionHistory(store, 'sample', intent)), { code: 'REPLAN_OPEN_FINDINGS' });
});
