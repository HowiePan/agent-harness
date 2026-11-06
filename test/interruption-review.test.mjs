import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { makeFixture, startRun, feature, dispatchAndBind, recordResult, command } from './test-support.mjs';
import { sha256, digestJson } from '../src/common/canonical.mjs';
import { featureContractDigest } from '../src/application/interruption-policy.mjs';
import { reviewableInterruptions, hasPendingIntervention, applyPendingInterruptionReviews, interruptionContext } from '../src/application/interruption-review.mjs';
import { decideInterruption } from '../src/application/interruption-policy.mjs';
import { resolveAttemptCarryover } from '../src/kernel/attempt-carryover.mjs';

const blocked = { status: 'blocked', summary: 'Worker estimates too much remaining work.', changedFiles: [],
  failureClass: 'capacity-mismatch', blocker: { kind: 'capacity', summary: '44 estimated versus 36 capacity.' } };
const fixture = async (t, { reserve = null } = {}) => {
  const f = await makeFixture(); t.after(f.cleanup);
  await mkdir(resolve(f.workspace, 'src'));
  await writeFile(resolve(f.workspace, 'src/owner.mjs'), 'export const existing = true;');
  await startRun(f, { features: [feature('owner', { stage: 'implementation', ...(reserve === null ? {} : { deliveryOwnerProposal: { id: 'owner', contracts: [], deliveryBatchReserve: reserve } }) }, { logicalRoot: 'owner', allowedPaths: ['src'] })] });
  const dispatched = await dispatchAndBind(f, 'run');
  const state = (await recordResult(f, 'run', dispatched.dispatch, blocked)).state;
  return { ...f, state };
};
const schedule = f => f.harness.scheduleInterruptionReview(f.projectId, 'run', 'owner', 'diagnose');
const reviewResult = async (f, dispatched, overrides = {}) => {
  const spec = dispatched.dispatch.featureSnapshot.metadata.intervention;
  return { status: 'completed', summary: 'Independent read-only diagnosis.', changedFiles: [], outputs: {
    diagnosis: { schemaId: 'execution-diagnosis-v1', evidenceRefs: ['src/owner.mjs'], value: {
      sourceSubmissionId: spec.sourceSubmissionId, contractDigest: spec.contractDigest, conclusion: 'in-scope',
      reason: 'Existing source eliminates rewriting; retain all original checks.',
      evidence: [{ path: 'src/owner.mjs', sha256: sha256(await readFile(resolve(f.workspace, 'src/owner.mjs'))) }],
      repairPaths: ['src/owner.mjs'], remainingWork: [{ work: 'Finish behavior', existingImplementation: 'Owner already exists.',
        remainingDevelopment: 'Wire one consumer.', verification: 'Run all approved checks.', unknowns: [], units: 4 }], ...overrides } } } };
};

test('unknown committed blocker reserves a read-only native task, accounts review, and reopens only the original unchanged contract', async t => {
  const f = await fixture(t); const before = featureContractDigest(f.state.features[0]);
  const attempts = digestJson(f.state.attempts);
  assert.equal(reviewableInterruptions(f.state).length, 1);
  const reserved = await schedule(f);
  assert.equal(reserved.state.metadata.interruptionLedger.length, 1);
  assert(hasPendingIntervention(reserved.state));
  assert.equal(reserved.state.features[0].state, 'blocked');
  const dispatched = await dispatchAndBind(f, 'run');
  assert.equal(dispatched.dispatch.featureSnapshot.kind, 'execution-diagnostic');
  assert.deepEqual(dispatched.dispatch.featureSnapshot.allowedPaths, []);
  const completed = (await recordResult(f, 'run', dispatched.dispatch, await reviewResult(f, dispatched))).state;
  assert.equal(completed.features[0].state, 'blocked');
  const applied = await f.harness.applyInterruptionReview(f.projectId, 'run', dispatched.dispatch.featureId, 'review');
  assert.equal(applied.state.features[0].state, 'pending');
  assert.equal(featureContractDigest(applied.state.features[0]), before);
  assert.equal(digestJson(applied.state.attempts), attempts);
  assert.equal(applied.state.metadata.interruptionLedger.length, 1);
  assert.equal(applied.state.decisions[0].actor, 'harness');
  assert.equal(applied.state.decisions[0].decision, 'verified');
  assert.equal((await dispatchAndBind(f, 'run')).dispatch.featureId, 'owner');
});

test('invalid repair scope gets one accounted clarification, never an expanded write grant or an unhandled exception', async t => {
  const f = await fixture(t); await schedule(f);
  const dispatched = await dispatchAndBind(f, 'run');
  const bad = await reviewResult(f, dispatched, { repairPaths: ['outside/owned-by-someone-else'] });
  await recordResult(f, 'run', dispatched.dispatch, bad);
  const corrected = await f.harness.applyInterruptionReview(f.projectId, 'run', dispatched.dispatch.featureId, 'bad-review');
  assert.equal(corrected.state.features[0].state, 'blocked');
  assert.equal(corrected.state.metadata.interruptionLedger.length, 2);
  const clarification = await dispatchAndBind(f, 'run');
  assert.equal(clarification.dispatch.featureSnapshot.metadata.intervention.correctionOf, corrected.state.submissions.at(-1).submissionId);
  assert.deepEqual(clarification.dispatch.featureSnapshot.allowedPaths, []);
  await recordResult(f, 'run', clarification.dispatch, await reviewResult(f, clarification, { repairPaths: ['outside'] }));
  const exhausted = await f.harness.applyInterruptionReview(f.projectId, 'run', clarification.dispatch.featureId, 'still-invalid');
  assert.equal(exhausted.result.correctionScheduled, false);
  assert.equal(exhausted.state.metadata.interruptionLedger.length, 2);
  assert.equal(hasPendingIntervention(exhausted.state), false);
  assert.equal(exhausted.state.features[0].state, 'blocked');
});

test('mixed historical evidence and ordinary pending verification are clarified inside the original allowance, then only the original task reopens', async t => {
  const f = await fixture(t); await schedule(f);
  await writeFile(resolve(f.workspace, 'historical.log'), 'old passed output is observation only');
  const log = { path: 'historical.log', sha256: sha256(await readFile(resolve(f.workspace, 'historical.log'))) };
  const first = await dispatchAndBind(f, 'run');
  const bad = await reviewResult(f, first);
  bad.outputs.diagnosis.value.evidence.push(log);
  bad.outputs.diagnosis.value.remainingWork[0].unknowns = ['Fresh tests have not run.'];
  await recordResult(f, 'run', first.dispatch, bad);
  const before = await f.harness.authorityStore.read(f.projectId, 'run');
  const originalResultDigest = before.submissions.at(-1).submissionDigest;
  const corrected = await f.harness.applyInterruptionReview(f.projectId, 'run', first.dispatch.featureId, 'assess-mixed');
  assert.equal(corrected.state.features[0].state, 'blocked');
  const second = await dispatchAndBind(f, 'run');
  const feedback = second.dispatch.featureSnapshot.metadata.intervention.validationFeedback;
  assert.deepEqual(feedback.issues.map(item => item.code), ['SOURCE_EVIDENCE_REQUIRED', 'QUESTION_DISPOSITION_REQUIRED']);
  const good = await reviewResult(f, second, { observations: [log] });
  good.outputs.diagnosis.value.remainingWork[0].unknowns = [{ question: 'Fresh tests have not run.',
    classification: 'verification-pending', action: 'Execute the original declared checks after development.',
    verification: 'Retain every original check and failed result.', unitsIncluded: true }];
  await recordResult(f, 'run', second.dispatch, good);
  const accepted = await f.harness.applyInterruptionReview(f.projectId, 'run', second.dispatch.featureId, 'accept-clarified');
  assert.equal(accepted.state.features[0].state, 'pending');
  assert.equal(accepted.state.metadata.interruptionLedger.length, 2);
  assert.equal(accepted.state.submissions.find(item => item.submissionDigest === originalResultDigest).result.outputs.diagnosis.value.evidence.length, 2);
  const assessment = accepted.state.decisions.findLast(item => item.kind === 'execution-intervention-assessment').assessment;
  assert.equal(assessment.observations[0].acceptanceCredit, false);
  const sealed = await f.harness.evidenceStore.read(assessment.observations[0].evidenceRef);
  assert.equal(sealed.bytes.toString(), 'old passed output is observation only');
  assert.equal((await dispatchAndBind(f, 'run')).dispatch.featureId, 'owner');
});

test('typed external questions cannot be relabeled as permission to continue', async t => {
  const f = await fixture(t); await schedule(f); const first = await dispatchAndBind(f, 'run');
  const result = await reviewResult(f, first);
  result.outputs.diagnosis.value.remainingWork[0].unknowns = [{ question: 'External dependency is unavailable.',
    classification: 'external-prerequisite', action: 'Obtain exact external input.', verification: 'Verify the input digest.', unitsIncluded: true }];
  await recordResult(f, 'run', first.dispatch, result);
  const applied = await f.harness.applyInterruptionReview(f.projectId, 'run', first.dispatch.featureId, 'external');
  assert.equal(applied.state.features[0].state, 'blocked');
  assert.equal(applied.state.metadata.interruptionLedger.length, 1);
  assert.equal(hasPendingIntervention(applied.state), false);
});

test('honest unresolved and external costs block without spending a format clarification', async t => {
  for (const classification of ['unresolved', 'external-prerequisite', 'contract-change']) {
    const f = await fixture(t); await schedule(f); const first = await dispatchAndBind(f, 'run');
    const result = await reviewResult(f, first, { conclusion: classification });
    result.outputs.diagnosis.value.remainingWork[0].unknowns = [{ question: 'The prerequisite cost or authority is not established.',
      classification, action: 'Obtain concrete source-bound reconciliation.', verification: 'Retain the original complete contract.', unitsIncluded: false }];
    await recordResult(f, 'run', first.dispatch, result);
    const applied = await f.harness.applyInterruptionReview(f.projectId, 'run', first.dispatch.featureId, `boundary-${classification}`);
    const assessment = applied.state.decisions.findLast(row => row.kind === 'execution-intervention-assessment').assessment;
    assert.equal(assessment.disposition, 'blocked');
    assert.deepEqual(assessment.issues, []);
    assert.equal(assessment.boundaries[0].classification, classification);
    assert.equal(applied.state.metadata.interruptionLedger.length, 1);
    assert.equal(applied.state.features[0].state, 'blocked');
    assert.equal(hasPendingIntervention(applied.state), false);
  }
});

test('ordinary uncosted work still requires clarification', async t => {
  const f = await fixture(t); await schedule(f); const first = await dispatchAndBind(f, 'run');
  const result = await reviewResult(f, first);
  result.outputs.diagnosis.value.remainingWork[0].unknowns = [{ question: 'A normal check remains.',
    classification: 'verification-pending', action: 'Run the original check.', verification: 'Keep all assertions.', unitsIncluded: false }];
  await recordResult(f, 'run', first.dispatch, result);
  const applied = await f.harness.applyInterruptionReview(f.projectId, 'run', first.dispatch.featureId, 'uncosted');
  assert.equal(applied.state.metadata.interruptionLedger.length, 2);
  assert.equal(applied.state.features.at(-1).metadata.intervention.validationFeedback.issues[0].code, 'QUESTION_DISPOSITION_REQUIRED');
});

test('a reserved clarification and original diagnosis survive formal replacement without a third reservation', async t => {
  const f = await fixture(t); await schedule(f); const first = await dispatchAndBind(f, 'run');
  await recordResult(f, 'run', first.dispatch, await reviewResult(f, first, { repairPaths: ['outside'] }));
  await f.harness.applyInterruptionReview(f.projectId, 'run', first.dispatch.featureId, 'clarify-before-recovery');
  const prior = await f.harness.authorityStore.read(f.projectId, 'run');
  const next = await f.harness.kernel.startRun({ projectId: f.projectId, runId: 'replacement', profileId: prior.profile.id,
    profileConfig: prior.profile.config, features: [f.state.features[0]], sourceDigest: prior.sourceDigest,
    pluginSetDigest: prior.pluginSetDigest, policyDigest: prior.policyDigest, metadata: prior.metadata,
    attemptCarryover: { logicalRoots: ['owner'], sources: [{ runId: prior.runId, authorityDigest: prior.authorityDigest }] } }, command());
  assert.equal(next.state.features.filter(item => item.kind === 'execution-diagnostic').length, 2);
  assert.equal(next.state.metadata.interruptionLedger.length, 2);
  assert(next.state.submissions.some(item => item.submissionId === prior.submissions.at(-1).submissionId));
  assert(hasPendingIntervention(next.state));
  const spec = next.state.features.find(item => item.kind === 'execution-diagnostic' && item.state === 'pending').metadata.intervention;
  assert(spec.correctionOf);
  assert.equal(await f.harness.scheduleInterruptionReview(f.projectId, 'replacement', 'owner', 'no-free-review'), null);
});

test('assessment-to-reservation crash resumes its exact clarification once, retaining the original diagnostic', async t => {
  const f = await fixture(t); await schedule(f); const first = await dispatchAndBind(f, 'run');
  await recordResult(f, 'run', first.dispatch, await reviewResult(f, first, { repairPaths: ['outside'] }));
  const scheduleIntervention = f.harness.kernel.scheduleIntervention;
  f.harness.kernel.scheduleIntervention = async () => { throw new Error('simulated process loss after assessment'); };
  await assert.rejects(f.harness.applyInterruptionReview(f.projectId, 'run', first.dispatch.featureId, 'crash'), /simulated process loss/);
  f.harness.kernel.scheduleIntervention = scheduleIntervention;
  const prior = await f.harness.authorityStore.read(f.projectId, 'run');
  assert.equal(prior.metadata.interruptionLedger.length, 1);
  assert(hasPendingIntervention(prior));
  const resumed = await applyPendingInterruptionReviews(f.harness, prior, 'resume-assessment');
  assert.equal(resumed.metadata.interruptionLedger.length, 2);
  assert.equal(resumed.features.filter(item => item.kind === 'execution-diagnostic').length, 2);
  assert.equal((await applyPendingInterruptionReviews(f.harness, resumed, 'resume-again')).revision, resumed.revision);
});

test('a model correction claim without a verified assessment cannot reserve another diagnostic', async t => {
  const f = await fixture(t); await schedule(f); const first = await dispatchAndBind(f, 'run');
  const current = (await recordResult(f, 'run', first.dispatch, await reviewResult(f, first))).state;
  const original = current.submissions[0], diagnostic = current.submissions.at(-1), parent = current.features[0];
  const context = interruptionContext(current, parent);
  const decision = decideInterruption({ ...context, problem: { ...context.problem, correctionOf: diagnostic.submissionId, assessmentId: 'invented-assessment' },
    facts: { ...context.facts, diagnosticCorrectionVerified: true }, capabilities: [{ id: 'review', operation: 'diagnose', available: true, authorized: true, evidenceBound: true, readOnly: true }] });
  const proof = await f.harness.evidenceStore.put(decision, { projectId: f.projectId, runId: 'run', featureId: parent.id,
    epoch: current.epoch, generation: current.generation, sourceDigest: current.sourceDigest });
  const candidate = structuredClone(current.features[1]);
  candidate.id = `diagnostic/${digestJson({ root: parent.logicalRoot, submissionId: original.submissionId, correctionOf: diagnostic.submissionId })}`;
  Object.assign(candidate.metadata.intervention, { correctionOf: diagnostic.submissionId, assessmentId: 'invented-assessment', decisionRef: proof.ref });
  await assert.rejects(f.harness.kernel.scheduleIntervention(f.projectId, 'run', { sourceFeatureId: parent.id,
    sourceSubmissionId: original.submissionId, evidenceRef: proof.ref, feature: candidate }, command(current)), { code: 'INTERVENTION_CORRECTION_INVALID' });
});

test('missing, escaping and changed observations never become source evidence or acceptance', async t => {
  for (const path of ['missing.log', '../outside.log', 'changed.log']) {
    const f = await fixture(t); await schedule(f); const first = await dispatchAndBind(f, 'run');
    if (path === 'changed.log') await writeFile(resolve(f.workspace, path), 'changed bytes');
    await recordResult(f, 'run', first.dispatch, await reviewResult(f, first, { observations: [{ path, sha256: '0'.repeat(64) }] }));
    const assessed = await f.harness.applyInterruptionReview(f.projectId, 'run', first.dispatch.featureId, 'invalid-observation');
    assert.equal(assessed.state.features[0].state, 'blocked');
    assert.equal(assessed.state.features.at(-1).metadata.intervention.validationFeedback.issues[0].code, 'OBSERVATION_INVALID');
  }
});

test('a smaller approved reserve bounds clarification rather than increasing the allowance', async t => {
  const f = await fixture(t, { reserve: 1 }); await schedule(f); const first = await dispatchAndBind(f, 'run');
  await recordResult(f, 'run', first.dispatch, await reviewResult(f, first, { repairPaths: ['outside'] }));
  const result = await f.harness.applyInterruptionReview(f.projectId, 'run', first.dispatch.featureId, 'no-reserve');
  assert.equal(result.result.correctionScheduled, false);
  assert.equal(result.state.metadata.interruptionLedger.length, 1);
  assert.equal(result.state.features.length, 2);
  assert.equal(hasPendingIntervention(result.state), false);
});

test('a crash after accepted assessment resumes reopening without repeating diagnosis or approval', async t => {
  const f = await fixture(t); await schedule(f); const first = await dispatchAndBind(f, 'run');
  await recordResult(f, 'run', first.dispatch, await reviewResult(f, first));
  const reopen = f.harness.kernel.reopenFeature;
  f.harness.kernel.reopenFeature = async () => { throw new Error('simulated process loss before reopen'); };
  await assert.rejects(f.harness.applyInterruptionReview(f.projectId, 'run', first.dispatch.featureId, 'crash-accepted'), /simulated process loss/);
  f.harness.kernel.reopenFeature = reopen;
  const state = await f.harness.authorityStore.read(f.projectId, 'run');
  const resumed = await applyPendingInterruptionReviews(f.harness, state, 'resume-accepted');
  assert.equal(resumed.features[0].state, 'pending');
  assert.equal(resumed.metadata.interruptionLedger.length, 1);
  assert.equal(resumed.decisions.filter(item => item.kind === 'execution-intervention').length, 1);
});

test('contract changes stay blocked while unclassified questions get bounded clarification without approving a plan', async t => {
  for (const [name, overrides] of [
    ['contract', { conclusion: 'contract-change' }],
    ['unknown', { remainingWork: [{ work: 'Unknown dependency', existingImplementation: 'Some exists.', remainingDevelopment: 'Unknown.', verification: 'All original checks.', unknowns: ['Needs source proof.'], units: 1 }] }],
  ]) {
    const f = await fixture(t); await schedule(f); const dispatched = await dispatchAndBind(f, 'run');
    await recordResult(f, 'run', dispatched.dispatch, await reviewResult(f, dispatched, overrides));
    await f.harness.applyInterruptionReview(f.projectId, 'run', dispatched.dispatch.featureId, `review-${name}`);
    const state = await f.harness.authorityStore.read(f.projectId, 'run');
    assert.equal(state.features[0].state, 'blocked'); assert(!state.decisions.some(item => item.kind === 'execution-intervention'));
    assert.equal(state.metadata.interruptionLedger.length, name === 'unknown' ? 2 : 1);
    assert.equal(reviewableInterruptions(state).length, 0);
  }
});

test('review history survives formal attempt transfer and an unchanged blocker cannot reserve another review', async t => {
  const f = await fixture(t); const reserved = await schedule(f);
  assert.equal(await f.harness.scheduleInterruptionReview(f.projectId, 'run', 'owner', 'again'), null);
  const dispatched = await dispatchAndBind(f, 'run');
  await recordResult(f, 'run', dispatched.dispatch, { ...blocked, summary: 'Read-only review could not resolve the required external input.' });
  const prior = await f.harness.authorityStore.read(f.projectId, 'run');
  const transfer = await resolveAttemptCarryover({ projectId: f.projectId, runId: 'replacement', attemptCarryover: {
    logicalRoots: ['owner'], sources: [{ runId: prior.runId, authorityDigest: prior.authorityDigest }] } }, [f.state.features[0]], f.harness.authorityStore);
  assert.deepEqual(transfer.interruptions, reserved.state.metadata.interruptionLedger);
  assert.equal(reviewableInterruptions(prior).length, 0);
});

test('a reserved pending diagnostic survives formal Run replacement without a new reservation or lost budget', async t => {
  const f = await fixture(t); await schedule(f);
  const prior = await f.harness.authorityStore.read(f.projectId, 'run');
  const next = await f.harness.kernel.startRun({ projectId: f.projectId, runId: 'replacement', profileId: prior.profile.id,
    profileConfig: prior.profile.config, features: [f.state.features[0]], sourceDigest: prior.sourceDigest,
    pluginSetDigest: prior.pluginSetDigest, policyDigest: prior.policyDigest, metadata: prior.metadata,
    attemptCarryover: { logicalRoots: ['owner'], sources: [{ runId: prior.runId, authorityDigest: prior.authorityDigest }] } }, command());
  assert.equal(next.state.features.length, 2);
  assert.equal(next.state.features[1].kind, 'execution-diagnostic');
  assert.equal(next.state.features[1].state, 'pending');
  assert(hasPendingIntervention(next.state));
  assert.deepEqual(next.state.metadata.interruptionLedger, prior.metadata.interruptionLedger);
  assert.deepEqual(next.state.attempts, prior.attempts);
});

test('diagnostic source writes cannot become a Submission or source acceptance', async t => {
  const f = await fixture(t); await schedule(f); const dispatched = await dispatchAndBind(f, 'run');
  const result = await reviewResult(f, dispatched);
  await writeFile(resolve(f.workspace, 'src/owner.mjs'), 'unauthorized diagnostic edit');
  result.changedFiles = ['src/owner.mjs'];
  await assert.rejects(recordResult(f, 'run', dispatched.dispatch, result), { code: 'FEATURE_PATH_NOT_ALLOWED' });
  const state = await f.harness.authorityStore.read(f.projectId, 'run');
  assert.equal(state.sourceDigest, f.state.sourceDigest);
  assert.equal(state.submissions.length, 1);
});

test('a verified user stop forbids scheduling, reopening and review, and formal transfer cannot clear it', async t => {
  const f = await fixture(t);
  const context = { projectId: f.projectId, runId: 'run', sourceDigest: f.state.sourceDigest, priorAuthorityDigest: f.state.authorityDigest };
  await assert.rejects(f.harness.kernel.recordDecision(f.projectId, 'run', { id: 'fake-stop', actor: 'agent', decision: 'approved',
    action: 'stop-execution', context }, command(f.state)), { code: 'OPERATOR_STOP_AUTHORITY_REQUIRED' });
  const stopped = await f.harness.kernel.recordDecision(f.projectId, 'run', { id: 'user-stop', actor: 'user', decision: 'approved',
    action: 'stop-execution', context }, command(f.state));
  assert.equal(stopped.state.metadata.operatorStop.requested, true);
  assert.equal(reviewableInterruptions(stopped.state).length, 0);
  await assert.rejects(f.harness.kernel.reopenFeature(f.projectId, 'run', { featureId: 'owner', reason: 'must not retry' }, command(stopped.state)),
    { code: 'OPERATOR_EXECUTION_STOPPED' });
  await assert.rejects(dispatchAndBind(f, 'run'), { code: 'OPERATOR_EXECUTION_STOPPED' });
  const transfer = await resolveAttemptCarryover({ projectId: f.projectId, runId: 'replacement', attemptCarryover: {
    logicalRoots: ['owner'], sources: [{ runId: 'run', authorityDigest: stopped.state.authorityDigest }] } }, [f.state.features[0]], f.harness.authorityStore);
  assert.deepEqual(transfer.operatorStop, stopped.state.metadata.operatorStop);
});
