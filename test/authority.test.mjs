import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthorityStore, EvidenceStore, ProjectRegistry, projectExecutionPolicyDecisionContext } from '../src/index.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { makeFixture } from './test-support.mjs';

test('authority transactions enforce revision and command idempotency', async t => {
  const fixture = await makeFixture(); t.after(() => fixture.cleanup());
  const store = new AuthorityStore({ root: fixture.dataRoot }); await store.init();
  const created = await store.create({ projectId: 'p', runId: 'r', value: 0 }, { commandId: 'create', payload: { value: 0 } });
  assert.equal(created.state.revision, 1);
  const first = await store.transact('p', 'r', { expectedRevision: 1, commandId: 'increment', payload: { by: 1 } }, state => { state.value += 1; return { value: state.value }; });
  assert.equal(first.state.value, 1);
  const duplicate = await store.transact('p', 'r', { expectedRevision: 1, commandId: 'increment', payload: { by: 1 } }, () => assert.fail('idempotent command must not execute twice'));
  assert.equal(duplicate.reused, true);
  assert.equal(duplicate.result.value, 1);
  await assert.rejects(() => store.transact('p', 'r', { expectedRevision: 1, commandId: 'stale', payload: {} }, () => null), error => error.code === 'REVISION_CONFLICT');
  await assert.rejects(() => store.transact('p', 'r', { expectedRevision: 2, commandId: 'increment', payload: { by: 2 } }, () => null), error => error.code === 'COMMAND_ID_REUSED');
});

test('evidence is content addressed and metadata context is independently addressed', async t => {
  const fixture = await makeFixture(); t.after(() => fixture.cleanup());
  const store = new EvidenceStore({ root: fixture.dataRoot });
  const base = { projectId: 'p', runId: 'r', epoch: 1, generation: 1, sourceDigest: 'source' };
  const first = await store.put({ ok: true }, { ...base, featureId: 'a', dispatchId: 'd1' });
  const second = await store.put({ ok: true }, { ...base, featureId: 'b', dispatchId: 'd2' });
  assert.notEqual(first.ref, second.ref);
  assert.equal(first.sha256, second.sha256);
  assert.equal((await store.read(first.ref)).metadata.featureId, 'a');
  assert.equal((await store.read(second.ref)).metadata.featureId, 'b');
});

test('transaction recovery distinguishes committed Authority from rolled-back journals', async t => {
  const fixture = await makeFixture(); t.after(() => fixture.cleanup());
  const store = new AuthorityStore({ root: fixture.dataRoot }); await store.init();
  await store.create({ projectId: 'p', runId: 'r' }, { commandId: 'create', payload: {} });
  const directory = resolve(fixture.dataRoot, 'transactions'); await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'orphan.json'), JSON.stringify({ protocolVersion: '1.0', transactionId: 'orphan', status: 'prepared', projectId: 'p', runId: 'r', commandId: 'never', nextRevision: 99, nextAuthorityDigest: 'missing' }));
  const recovered = await store.recoverTransactions();
  assert.deepEqual(recovered, [{ transactionId: 'orphan', status: 'rolled-back' }]);
});

test('Project Registry updates are idempotent and high-impact changes require Authority approval', async t => {
  const fixture = await makeFixture({ projectId: 'registry-project' }); t.after(() => fixture.cleanup());
  const unsafeRegistry = new ProjectRegistry({ root: resolve(fixture.workspace, '.harness-state') });
  await assert.rejects(() => unsafeRegistry.register({ id: 'unsafe', workspace: { root: fixture.workspace }, profiles: ['feature-delivery'] }, { commandId: 'unsafe-register' }), error => error.code === 'STATE_ROOT_INSIDE_WORKSPACE');
  const current = await fixture.harness.projectRegistry.get('registry-project');
  const same = await fixture.harness.projectRegistry.register({ id: 'registry-project', workspace: current.workspace, profiles: current.profiles, policy: current.policy }, { expectedRevision: current.revision, commandId: 'update-same' });
  const duplicate = await fixture.harness.projectRegistry.register({ id: 'registry-project', workspace: current.workspace, profiles: current.profiles, policy: current.policy }, { expectedRevision: current.revision, commandId: 'update-same' });
  assert.equal(duplicate.revision, same.revision);
  await assert.rejects(() => fixture.harness.projectRegistry.register({ id: 'registry-project', workspace: current.workspace, profiles: ['engine-delivery'], policy: current.policy }, { expectedRevision: same.revision, commandId: 'high-impact' }), error => error.code === 'PROJECT_AUTHORITY_DECISION_REQUIRED');
  const approved = await fixture.harness.projectRegistry.register({ id: 'registry-project', workspace: current.workspace, profiles: ['engine-delivery'], policy: current.policy }, { expectedRevision: same.revision, commandId: 'high-impact', authorityDecision: { id: 'user-change', actor: 'user', decision: 'approved' } });
  assert.deepEqual(approved.profiles, ['engine-delivery']);
  await assert.rejects(() => fixture.harness.projectRegistry.register({ id: 'registry-project', workspace: approved.workspace, profiles: approved.profiles, policy: approved.policy, gateRecipes: [{ id: 'new-final', command: ['node', '--version'], scope: 'final' }] }, { expectedRevision: approved.revision, commandId: 'gate-change' }), error => error.code === 'PROJECT_AUTHORITY_DECISION_REQUIRED');
});

test('Project Registry requires an exact, expiring Decision for headless policy changes', async t => {
  const fixture = await makeFixture({ projectId: 'execution-policy-project', policy: { agentExecutionMode: 'conversation-visible' } });
  t.after(() => fixture.cleanup());
  const current = await fixture.harness.projectRegistry.get(fixture.projectId);
  const next = { ...current, policy: { ...current.policy, agentExecutionMode: 'headless' } };
  delete next.protocolVersion;
  delete next.revision;
  delete next.updatedAt;
  delete next.commands;
  delete next.descriptorDigest;
  const generic = { actor: 'user', decision: 'approved' };
  await assert.rejects(
    () => fixture.harness.projectRegistry.register(next, { expectedRevision: current.revision, commandId: 'generic-headless-change', authorityDecision: generic }),
    error => error.code === 'PROJECT_EXECUTION_POLICY_AUTHORITY_REQUIRED',
  );
  const context = projectExecutionPolicyDecisionContext({ current, input: next, expectedRevision: current.revision });
  await assert.rejects(
    () => fixture.harness.projectRegistry.register(next, { expectedRevision: current.revision, commandId: 'wrong-headless-context', authorityDecision: { actor: 'user', decision: 'approved', action: 'project-execution-policy-change', expiresAt: '2099-09-15T00:00:00.000Z', context: { ...context, projectId: 'other' } } }),
    error => error.code === 'PROJECT_EXECUTION_POLICY_DECISION_CONTEXT_MISMATCH',
  );
  const updated = await fixture.harness.projectRegistry.register(next, { expectedRevision: current.revision, commandId: 'exact-headless-change', authorityDecision: { actor: 'user', decision: 'approved', action: 'project-execution-policy-change', expiresAt: '2099-09-15T00:00:00.000Z', context } });
  assert.equal(updated.policy.agentExecutionMode, 'headless');
});

test('Project Registry rejects execution grants and legacy authorization even in development mode', async t => {
  const fixture = await makeFixture({ projectId: 'no-persisted-grant' });
  t.after(() => fixture.cleanup());
  const current = await fixture.harness.projectRegistry.get(fixture.projectId);
  const base = { id: current.id, workspace: current.workspace, profiles: current.profiles, policy: current.policy };
  await assert.rejects(
    () => fixture.harness.projectRegistry.register({ ...base, policy: { ...base.policy, executionGrant: { decision: 'approved' } } }, { expectedRevision: current.revision, commandId: 'persist-grant' }),
    error => error.code === 'DESCRIPTOR_EXECUTION_AUTHORIZATION_FORBIDDEN',
  );
  await assert.rejects(
    () => fixture.harness.projectRegistry.register({ ...base, policy: { ...base.policy, actionExecution: { quality: { agentExecutionMode: 'headless', runtimePluginId: 'test-runtime', authorization: { actor: 'user', decision: 'approved' } } } } }, { expectedRevision: current.revision, commandId: 'persist-legacy-approval' }),
    error => error.code === 'LEGACY_DESCRIPTOR_AUTHORIZATION_FORBIDDEN',
  );
});
