import assert from 'node:assert/strict';
import test from 'node:test';
import { digestJson, withoutKeys } from '../src/common/canonical.mjs';
import { isInterruptedImplementationSubmission, verifyInterruptedImplementationResume } from '../src/application/lifecycle-interruption.mjs';
import { selectBlockedResumeFeature } from '../src/application/lifecycle-resume.mjs';

const fixture = () => {
  const source = 'a'.repeat(64), packet = 'b'.repeat(64), prompt = 'c'.repeat(64);
  const feature = { id: 'f', logicalRoot: 'implement:f', state: 'blocked', metadata: { stage: 'implementation' } };
  const result = { status: 'failed', changedFiles: [], failureClass: 'runtime-interrupted',
    blocker: { kind: 'runtime-interrupted', code: 'CODEX_COLLABORATION_AGENT_INTERRUPTED' } };
  const submission = { submissionId: 's', featureId: 'f', leaseId: 'l', dispatchId: 'd', agentId: 'agent',
    inputSourceDigest: source, outputSourceDigest: source, changedFiles: [], evidenceRefs: ['e'], result };
  submission.submissionDigest = digestJson(submission);
  const terminal = { kind: 'host-terminal-failure-receipt', version: '1.0', agentId: 'agent', dispatchId: 'd',
    packetDigest: packet, promptDigest: prompt, code: result.blocker.code, resultDigest: digestJson(result),
    resultContractDigest: 'e'.repeat(64),
    nativeStatusDigest: digestJson('interrupted'), observationRequestDigest: 'd'.repeat(64) };
  terminal.receiptDigest = digestJson(terminal);
  const record = { inputSourceDigest: source, outputSourceDigest: source, result: structuredClone(result),
    runtimeEvidence: { hostTerminalFailure: terminal, hostResultReceipt: {
      provider: 'codex-host', operation: 'result', agentId: 'agent', dispatchId: 'd', effectId: 'effect',
      resultDigest: terminal.resultDigest, observationRequestDigest: terminal.observationRequestDigest,
      terminalFailureDigest: terminal.receiptDigest } } };
  const metadata = { projectId: 'p', runId: 'r', featureId: 'f', dispatchId: 'd', sourceDigest: source, epoch: 1, generation: 1 };
  const state = { projectId: 'p', runId: 'r', sourceDigest: source,
    features: [{ id: 'completed', state: 'completed' }, feature], submissions: [submission],
    attempts: { 'implement:f:runtime-interrupted': { failures: 1, limit: 3, exhausted: false } },
    leases: [{ leaseId: 'l', dispatchId: 'd', agentId: 'agent', packetDigest: packet, status: 'committed', epoch: 1, generation: 1,
      runtimeReceipt: { resultContractDigest: terminal.resultContractDigest, prompt: { promptDigest: prompt }, hostSpawnReceipt: { agentId: 'agent', dispatchId: 'd',
        effectId: 'effect', packetDigest: packet, promptDigest: prompt } } }],
    dispatches: [{ dispatchId: 'd', featureId: 'f', packetDigest: packet, status: 'committed', epoch: 1, generation: 1 }] };
  const evidenceStore = { read: async ref => { assert.equal(ref, 'e');
    return { metadata, bytes: Buffer.from(JSON.stringify(record)) }; } };
  return { state, feature, submission, record, metadata, evidenceStore };
};

test('bound unchanged-source interruption resumes without completing work or resetting history', async () => {
  const f = fixture();
  const before = digestJson(f.state);
  assert.equal(selectBlockedResumeFeature(f.state), 'f');
  await verifyInterruptedImplementationResume(f);
  assert.equal(digestJson(f.state), before);
  assert.equal(f.state.features[0].state, 'completed');
  f.state.attempts['implement:f:runtime-interrupted'].exhausted = true;
  assert.throws(() => selectBlockedResumeFeature(f.state), { code: 'LIFECYCLE_RESUME_BUDGET_EXHAUSTED' });
});

test('interruption rejects source changes, active work, missing or mismatched native evidence', async () => {
  const mutations = [
    f => { f.state.sourceDigest = 'e'.repeat(64); },
    f => { f.submission.changedFiles = ['src/draft']; },
    f => { f.submission.result.changedFiles = ['src/draft']; },
    f => { f.submission.evidenceRefs = []; },
    f => { f.state.leases[0].status = 'active'; },
    f => { f.state.dispatches[0].status = 'assigned'; },
    f => { f.state.leases[0].runtimeReceipt.hostSpawnReceipt.promptDigest = 'other'; },
    f => { f.metadata.runId = 'other'; },
    f => { f.metadata.sourceDigest = 'other'; },
    f => { f.metadata.generation = 2; },
    f => { f.record.runtimeEvidence.hostTerminalFailure.resultContractDigest = 'other'; },
    f => { f.record.outputSourceDigest = 'other'; },
    f => { f.record.result.status = 'completed'; },
    f => { delete f.record.runtimeEvidence.hostTerminalFailure; },
    f => { f.record.runtimeEvidence.hostTerminalFailure.promptDigest = 'other'; },
    f => { f.record.runtimeEvidence.hostTerminalFailure.nativeStatusDigest = digestJson('running'); },
    f => { f.record.runtimeEvidence.hostResultReceipt.effectId = 'other'; },
    f => { f.record.runtimeEvidence.hostResultReceipt.observationRequestDigest = 'other'; },
    f => { f.record.runtimeEvidence.hostResultReceipt.terminalFailureDigest = 'other'; },
    f => { f.record.runtimeEvidence.resultRejection = {}; },
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    f.submission.submissionDigest = digestJson(withoutKeys(f.submission, ['submissionDigest']));
    await assert.rejects(() => verifyInterruptedImplementationResume(f), { code: 'LIFECYCLE_RESUME_INTERRUPTION_UNVERIFIED' });
  }
});

test('other blocker kinds and unproved interruption strings do not gain retry authority', () => {
  for (const kind of ['permission-denied', 'external-prerequisite', 'runtime-contract', 'runtime-blocked']) {
    const f = fixture();
    f.submission.result.failureClass = kind; f.submission.result.blocker.kind = kind;
    assert.equal(isInterruptedImplementationSubmission(f.state, f.feature, f.submission), false);
    assert.throws(() => selectBlockedResumeFeature(f.state), { code: 'LIFECYCLE_RESUME_BLOCKER_REQUIRES_REVIEW' });
  }
  const f = fixture(); f.submission.result.blocker.code = 'AGENT_SAYS_INTERRUPTED';
  assert.throws(() => selectBlockedResumeFeature(f.state), { code: 'LIFECYCLE_RESUME_BLOCKER_REQUIRES_REVIEW' });
});
