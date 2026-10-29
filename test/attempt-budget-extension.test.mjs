import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digestJson } from '../src/common/canonical.mjs';
import { prepareBudgetExtension, selectAttemptBudget, submissionAttempt } from '../src/kernel/attempt-budget.mjs';
import { implementationAttemptBudget } from '../src/flows/delivery-lifecycle/policy/implementation-progress.mjs';
import { selectBlockedResumeFeature } from '../src/application/lifecycle-resume.mjs';
import { shouldContinueImplementationProgress } from '../src/application/lifecycle-execution-service.mjs';
import { verifyImplementationBudgetScope } from '../src/application/implementation-budget.mjs';
import { command, dispatchAndBind, feature, makeFixture, recordResult } from './test-support.mjs';

const partial = { status: 'blocked', failureClass: 'implementation-incomplete', summary: 'Verified partial progress.',
  blocker: { kind: 'in-scope-fix-blocked', summary: 'Finish the remaining owner certificates.' } };
const blocked = () => ({ projectId: 'project', runId: 'run', revision: 5, authorityDigest: 'a'.repeat(64),
  sourceDigest: 'b'.repeat(64), epoch: 1, generation: 1, status: 'all-remaining-blocked',
  profile: { id: 'feature-delivery', config: {} }, metadata: { lifecyclePlanDigest: 'c'.repeat(64) },
  features: [{ ...feature('A-02', { stage: 'implementation', implementationProgressRetries: 20 }), logicalRoot: 'root:A-02', state: 'failed-budget' }],
  attempts: { 'root:A-02:implementation-incomplete': { key: 'root:A-02:implementation-incomplete', logicalRoot: 'root:A-02',
    failures: 21, limit: 21, exhausted: true, records: [{ submissionId: 's1' }] } },
  submissions: [{ submissionId: 's1', featureId: 'A-02', result: partial, inputSourceDigest: 'old',
    outputSourceDigest: 'b'.repeat(64), changedFiles: ['work/A-02/one'], evidenceRefs: ['evidence:one'] }],
  leases: [], dispatches: [], decisions: [], events: [], findings: [] });
const request = { featureId: 'A-02', attemptKey: 'root:A-02:implementation-incomplete', additional: 20,
  reason: 'The bounded implementation made verified progress and needs additional continuation.', remainingWork: ['Complete the producer certificates.', 'Retire the legacy source.'] };
const approvalFor = proposal => ({ id: 'budget-approved-1', actor: 'human-user', decision: 'approved', action: 'extend-attempt-budget',
  projectId: proposal.projectId, runId: proposal.runId, featureId: proposal.featureId, proposalDigest: proposal.proposalDigest });

test('budget preview is pure and rejects unbounded, stale-scope and active-work requests', () => {
  const state = blocked();
  const original = digestJson(state);
  const proposal = prepareBudgetExtension({ state, ...request });
  assert.equal(proposal.used, 21); assert.equal(proposal.afterLimit, 41);
  assert.equal(digestJson(state), original);
  for (const additional of [0, -1, 21, 1.5, Infinity, NaN]) {
    assert.throws(() => prepareBudgetExtension({ state, ...request, additional }), { code: 'BUDGET_EXTENSION_LIMIT_INVALID' });
  }
  for (const mutate of [s => { s.leases.push({ status: 'active' }); }, s => { s.dispatches.push({ status: 'requested' }); },
    s => { s.status = 'closed'; }]) {
    const next = blocked(); mutate(next);
    assert.throws(() => prepareBudgetExtension({ state: next, ...request }), { code: 'BUDGET_EXTENSION_RUN_NOT_IDLE' });
  }
  assert.throws(() => prepareBudgetExtension({ state, ...request, attemptKey: 'other' }), { code: 'BUDGET_EXTENSION_SCOPE_MISMATCH' });
  assert.throws(() => prepareBudgetExtension({ state, ...request, reason: '' }), { code: 'BUDGET_EXTENSION_REASON_REQUIRED' });
  state.attempts[request.attemptKey].limit = 1000;
  assert.throws(() => prepareBudgetExtension({ state, ...request }), { code: 'BUDGET_EXTENSION_LIMIT_INVALID' });
});

test('approved legacy addition preserves contracts and failures, is atomic/idempotent, and only enables later resume', async t => {
  const fixture = await makeFixture(); t.after(fixture.cleanup);
  const { authorityStore, kernel } = fixture.harness;
  let state = (await authorityStore.create(blocked(), { commandId: 'seed', payload: {} })).state;
  const proposal = prepareBudgetExtension({ state, ...request });
  const input = { proposal, approval: approvalFor(proposal) };
  const before = structuredClone(state);
  for (const change of [a => { a.proposalDigest = 'wrong'; }, a => { a.actor = 'agent'; }, a => { a.runId = 'other'; },
    a => { a.decision = 'rejected'; }]) {
    const invalid = structuredClone(input); change(invalid.approval);
    await assert.rejects(kernel.extendAttemptBudget('project', 'run', invalid, { expectedRevision: state.revision, commandId: `bad-${invalid.approval.actor}-${invalid.approval.runId}-${invalid.approval.decision}-${invalid.approval.proposalDigest}` }),
      { code: 'BUDGET_EXTENSION_APPROVAL_REQUIRED' });
  }
  await assert.rejects(kernel.extendAttemptBudget('project', 'run', { ...input, proposal: { ...proposal, reason: 'tampered' } },
    { expectedRevision: state.revision, commandId: 'tampered' }), { code: 'BUDGET_EXTENSION_PROPOSAL_STALE' });
  assert.equal((await authorityStore.read('project', 'run')).authorityDigest, before.authorityDigest);
  const cmd = { expectedRevision: state.revision, commandId: 'approved-addition' };
  const applied = await kernel.extendAttemptBudget('project', 'run', input, cmd); state = applied.state;
  assert.equal(state.attempts[request.attemptKey].failures, 21);
  assert.equal(state.attempts[request.attemptKey].limit, 41);
  assert.equal(state.attempts[request.attemptKey].exhausted, false);
  assert.deepEqual(state.submissions, before.submissions);
  assert.deepEqual(state.features[0].acceptance, before.features[0].acceptance);
  assert.equal(state.features[0].state, 'blocked');
  assert.equal(state.dispatches.length, 0); assert.equal(state.leases.length, 0);
  assert.equal(state.metadata.lifecyclePlanDigest, before.metadata.lifecyclePlanDigest);
  assert.equal(selectBlockedResumeFeature(state), 'A-02');
  assert.equal(shouldContinueImplementationProgress({ feature: state.features[0], result: partial, state, submission: state.submissions[0] }), true);
  assert.equal(state.events.at(-1).type, 'attempt.budget-extended');
  assert.equal((await kernel.extendAttemptBudget('project', 'run', input, cmd)).reused, true);
  await assert.rejects(kernel.extendAttemptBudget('project', 'run', input, { ...cmd, commandId: 'stale-addition' }), { code: 'REVISION_CONFLICT' });
});

test('new progress accounting requires evidence and unique source progress; old accounting stays pinned', () => {
  const state = blocked(); state.metadata.attemptAccounting = 'separate-progress-v1'; state.submissions = [];
  const item = state.features[0]; item.attemptLimit = 21;
  const submission = { ...blocked().submissions[0], inputSourceDigest: 'a', outputSourceDigest: 'b' };
  const profile = { attemptBudget: implementationAttemptBudget };
  const select = sub => selectAttemptBudget({ state, feature: item, submission: sub, profile });
  assert.deepEqual(select(submission), { key: 'root:A-02:progress', budgetKind: 'progress', limit: 21 });
  for (const sub of [{ ...submission, evidenceRefs: [] }, { ...submission, changedFiles: [] },
    { ...submission, outputSourceDigest: 'a' }, { ...submission, result: { ...partial, status: 'failed' } },
    { ...submission, result: { ...partial, failureClass: 'external-dependency' } }]) {
    assert.equal(select(sub).budgetKind, 'failure'); assert.equal(select(sub).limit, 3);
  }
  state.submissions.push({ ...submission, submissionId: 'previous', outputSourceDigest: 'b' });
  assert.equal(select(submission).budgetKind, 'failure');
  delete state.metadata.attemptAccounting;
  assert.equal(select(submission).limit, 21);
});

test('implementation budget scope rejects external blockers, a different Feature, checkout and source drift', async () => {
  const state = blocked();
  state.metadata.commandIntent = { action: 'implement' };
  state.metadata.workspace = { root: process.cwd() };
  const project = { workspace: { root: process.cwd() } };
  const input = { harness: { projectRegistry: { get: async () => project } }, state,
    featureId: 'A-02', currentSourceDigest: state.sourceDigest };
  await verifyImplementationBudgetScope(input);
  const historical = structuredClone(state);
  historical.submissions[0].result.blocker.kind = 'implementation';
  await verifyImplementationBudgetScope({ ...input, state: historical });
  historical.submissions[0].evidenceRefs = [];
  await assert.rejects(verifyImplementationBudgetScope({ ...input, state: historical }), { code: 'IMPLEMENTATION_BUDGET_SCOPE_MISMATCH' });
  for (const mutate of [s => { s.metadata.commandIntent.action = 'quality'; },
    s => { s.submissions[0].result.blocker.kind = 'external-dependency'; },
    s => { s.submissions[0].result.status = 'completed'; }]) {
    const next = structuredClone(state); mutate(next);
    await assert.rejects(verifyImplementationBudgetScope({ ...input, state: next }), { code: 'IMPLEMENTATION_BUDGET_SCOPE_MISMATCH' });
  }
  await assert.rejects(verifyImplementationBudgetScope({ ...input, featureId: 'other' }), { code: 'IMPLEMENTATION_BUDGET_SCOPE_MISMATCH' });
  await assert.rejects(verifyImplementationBudgetScope({ ...input, currentSourceDigest: 'changed' }), { code: 'IMPLEMENTATION_BUDGET_SOURCE_CHANGED' });
  const moved = structuredClone(state); moved.metadata.workspace.root = resolve(process.cwd(), 'other');
  await assert.rejects(verifyImplementationBudgetScope({ ...input, state: moved }), { code: 'IMPLEMENTATION_BUDGET_WORKSPACE_MISMATCH' });
});

test('committed capacity progress permits a bounded proposal and resumes only after exact approval', async t => {
  const fixture = await makeFixture(); t.after(fixture.cleanup);
  const initial = blocked();
  initial.metadata.commandIntent = { action: 'implement' };
  initial.metadata.workspace = { root: process.cwd() };
  initial.metadata.attemptAccounting = 'separate-progress-v1';
  const submission = initial.submissions[0];
  submission.dispatchId = 'dispatch-capacity';
  submission.attemptBudgetKey = 'root:A-02:progress';
  submission.result = { ...partial, failureClass: 'external-prerequisite-and-incomplete-implementation',
    blocker: { kind: 'context-limit', summary: 'Capacity reached; another approved local certificate remains.' },
    checkpoints: [{ id: 'approved-obligation', status: 'completed', evidence: ['proof/new'] }],
    deliveryPrerequisites: [{ id: 'external-receipt', reason: 'Required before later source removal.' }] };
  initial.dispatches = [{ dispatchId: submission.dispatchId, featureId: 'A-02', status: 'committed', execution: {
    implementationContinuation: { policy: 'approved-obligation-progress/1', obligations: [{ id: 'approved-obligation' }] } } }];
  initial.attempts = { [submission.attemptBudgetKey]: { key: submission.attemptBudgetKey, logicalRoot: 'root:A-02',
    budgetKind: 'progress', used: 21, failures: 0, limit: 21, exhausted: true,
    records: [{ submissionId: submission.submissionId, dispatchId: submission.dispatchId }] } };
  const scope = state => ({ harness: { projectRegistry: { get: async () => ({ workspace: { root: process.cwd() } }) } },
    state, featureId: 'A-02', currentSourceDigest: state.sourceDigest });
  await verifyImplementationBudgetScope(scope(initial));
  for (const kind of ['context-limit', 'context-capacity']) {
    const copy = structuredClone(initial); copy.submissions[0].result.blocker.kind = kind;
    await verifyImplementationBudgetScope(scope(copy));
  }
  for (const mutate of [s => { s.submissions[0].evidenceRefs = []; },
    s => { s.submissions[0].result.checkpoints[0].id = 'unapproved'; },
    s => { s.submissions[0].result.checkpoints[0].evidence = []; },
    s => { s.submissions[0].result.blocker.kind = 'external-dependency'; },
    s => { s.submissions[0].result.blocker.kind = 'approval'; },
    s => { s.submissions[0].result.failureClass = 'external-dependency'; },
    s => { s.submissions[0].result.status = 'failed'; },
    s => { s.submissions[0].outputSourceDigest = 'stale'; },
    s => { s.submissions[0].supersededAt = 'earlier'; },
    s => { s.dispatches[0].status = 'assigned'; },
    s => { s.dispatches[0].execution.implementationContinuation.policy = 'unknown'; },
    s => { s.attempts['root:A-02:progress'].budgetKind = 'failure'; },
    s => { s.attempts['root:A-02:progress'].records[0].dispatchId = 'other'; },
    s => { s.submissions.unshift({ ...structuredClone(s.submissions[0]), submissionId: 'prior' }); }]) {
    const copy = structuredClone(initial); mutate(copy);
    await assert.rejects(verifyImplementationBudgetScope(scope(copy)), { code: 'IMPLEMENTATION_BUDGET_SCOPE_MISMATCH' });
  }
  let state = (await fixture.harness.authorityStore.create(initial, { commandId: 'seed-capacity', payload: {} })).state;
  assert.throws(() => selectBlockedResumeFeature({ ...state, features: [{ ...state.features[0], state: 'blocked' }] }),
    { code: 'LIFECYCLE_RESUME_BUDGET_EXHAUSTED' });
  const proposal = prepareBudgetExtension({ state, ...request, attemptKey: submission.attemptBudgetKey });
  state = (await fixture.harness.kernel.extendAttemptBudget(state.projectId, state.runId,
    { proposal, approval: approvalFor(proposal) }, { expectedRevision: state.revision, commandId: 'extend-capacity' })).state;
  assert.equal(selectBlockedResumeFeature(state), 'A-02');
  assert.equal(state.attempts[submission.attemptBudgetKey].used, 21);
  assert.equal(state.attempts[submission.attemptBudgetKey].limit, 41);
  assert.deepEqual(state.submissions[0].result.deliveryPrerequisites, submission.result.deliveryPrerequisites);
});

test('managed submissions keep progress and real failures in different bounded ledgers across resume', async t => {
  const fixture = await makeFixture({ profiles: ['engine-delivery'] }); t.after(fixture.cleanup);
  const { harness } = fixture;
  const started = await harness.startRun({ projectId: fixture.projectId, runId: 'progress', profileId: 'engine-delivery',
    profileConfig: { requireCanonicalDecision: false, requireUserCodeReview: false },
    features: [feature('one', { stage: 'implementation', implementationProgressRetries: 2 }, { attemptLimit: 21 })],
    metadata: { attemptAccounting: 'separate-progress-v1' }, executionAuthorizationEvidence: { explicitUnattended: true } }, command());
  assert.equal(started.state.metadata.attemptAccounting, 'separate-progress-v1');
  const first = await dispatchAndBind(fixture, 'progress');
  await mkdir(resolve(fixture.workspace, 'work', 'one'), { recursive: true });
  await writeFile(resolve(fixture.workspace, 'work', 'one', 'file.txt'), 'progress one');
  let output = await recordResult(fixture, 'progress', first.dispatch, { ...partial, changedFiles: ['work/one/file.txt'] });
  let state = output.state;
  const progress = submissionAttempt(state, state.features[0], state.submissions.at(-1));
  assert.equal(progress.budgetKind, 'progress'); assert.equal(progress.used, 1); assert.equal(progress.failures, 0);
  assert.equal(Object.keys(state.attempts).length, 1);
  state = (await harness.kernel.reopenFeature(fixture.projectId, 'progress', { featureId: 'one', reason: 'continue' }, command(state))).state;
  const second = await dispatchAndBind(fixture, 'progress');
  output = await recordResult(fixture, 'progress', second.dispatch, partial); state = output.state;
  const failure = submissionAttempt(state, state.features[0], state.submissions.at(-1));
  assert.equal(failure.budgetKind, 'failure'); assert.equal(failure.failures, 1); assert.equal(failure.limit, 3);
  assert.equal(state.attempts['one:progress'].used, 1);
  for (const text of ['progress two', 'progress three']) {
    state = (await harness.kernel.reopenFeature(fixture.projectId, 'progress', { featureId: 'one', reason: 'continue' }, command(state))).state;
    const next = await dispatchAndBind(fixture, 'progress');
    await writeFile(resolve(fixture.workspace, 'work', 'one', 'file.txt'), text);
    state = (await recordResult(fixture, 'progress', next.dispatch, { ...partial, changedFiles: ['work/one/file.txt'] })).state;
  }
  assert.equal(state.features[0].state, 'failed-budget');
  assert.equal(state.attempts['one:progress'].used, 3);
  assert.equal(state.attempts['one:implementation-incomplete'].failures, 1);
  await assert.rejects(harness.kernel.reopenFeature(fixture.projectId, 'progress', { featureId: 'one' }, command(state)), { code: 'FEATURE_NOT_REOPENABLE' });
  const proposal = prepareBudgetExtension({ state, featureId: 'one', attemptKey: 'one:progress', additional: 2,
    reason: 'Two additional verified progress continuations.', remainingWork: ['Finish the unchanged task.'] });
  state = (await harness.kernel.extendAttemptBudget(fixture.projectId, 'progress', { proposal, approval: approvalFor(proposal) }, command(state))).state;
  assert.equal(state.attempts['one:progress'].limit, 5);
  assert.equal(state.attempts['one:progress'].used, 3);
  assert.equal(selectBlockedResumeFeature(state), 'one');
  assert.equal(state.features[0].state, 'blocked');
});
