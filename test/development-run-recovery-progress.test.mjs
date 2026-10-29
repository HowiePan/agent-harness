import assert from 'node:assert/strict';
import test from 'node:test';
import { digestJson } from '../src/common/canonical.mjs';
import { terminalFailureProgress } from '../src/application/development-run-recovery.mjs';

test('only a bound native failure Submission may advance a patch-captured Run', async () => {
  const run = { revision: 10, activeLeaseIds: ['lease-1'], activeDispatchIds: ['dispatch-1'] };
  const result = { status: 'failed', summary: 'Host failed', changedFiles: ['src/f06.rs'],
    failureClass: 'runtime-provider', blocker: { kind: 'runtime-provider', code: 'HOST_AGENT_FAILED', summary: 'Host failed' } };
  const submissionBody = { submissionId: 'submission-1', leaseId: 'lease-1', dispatchId: 'dispatch-1',
    featureId: 'feature-f06', agentId: 'agent-1', inputSourceDigest: 'a'.repeat(64),
    outputSourceDigest: 'b'.repeat(64), changedFiles: ['src/f06.rs'], result,
    evidenceRefs: ['evidence-1'] };
  const submission = { ...submissionBody, submissionDigest: digestJson(submissionBody) };
  const terminalBody = { kind: 'host-terminal-failure-receipt', version: '1.0', agentId: 'agent-1',
    dispatchId: 'dispatch-1', packetDigest: 'c'.repeat(64), promptDigest: 'd'.repeat(64),
    code: 'HOST_AGENT_FAILED', resultDigest: digestJson({ ...result, changedFiles: [] }) };
  const terminal = { ...terminalBody, receiptDigest: digestJson(terminalBody) };
  const state = { projectId: 'project', runId: 'run', revision: 13, sourceDigest: 'b'.repeat(64),
    events: [
      { sequence: 11, type: 'lease.heartbeat', progress: 'terminal-failure-recovery', leaseId: 'lease-1' },
      { sequence: 12, type: 'lease.heartbeat', progress: 'terminal-result-observed', leaseId: 'lease-1' },
      { sequence: 13, type: 'submission.committed', status: 'blocked', featureId: 'feature-f06', submissionId: 'submission-1' },
    ],
    features: [{ id: 'feature-f06', metadata: { stage: 'implementation' } }],
    leases: [{ leaseId: 'lease-1', agentId: 'agent-1', packetDigest: 'c'.repeat(64),
      runtimeReceipt: { prompt: { promptDigest: 'd'.repeat(64) }, hostSpawnReceipt: { effectId: 'effect-1' } } }],
    dispatches: [{ dispatchId: 'dispatch-1', packetDigest: 'c'.repeat(64) }], submissions: [submission] };
  const evidenceStore = { read: async () => ({ metadata: { projectId: 'project', runId: 'run',
    featureId: 'feature-f06', dispatchId: 'dispatch-1' }, bytes: Buffer.from(JSON.stringify({
    inputSourceDigest: submission.inputSourceDigest, outputSourceDigest: submission.outputSourceDigest,
    result, runtimeEvidence: { hostTerminalFailure: terminal,
      hostResultReceipt: { terminalFailureDigest: terminal.receiptDigest, agentId: 'agent-1',
        dispatchId: 'dispatch-1', effectId: 'effect-1', resultDigest: terminal.resultDigest } },
  })) }) };
  assert.equal(await terminalFailureProgress(run, state, evidenceStore), true);
  assert.equal(await terminalFailureProgress(run, { ...state, events: [...state.events,
    { sequence: 15, type: 'feature.reopened' }] }, evidenceStore), false);
  assert.equal(await terminalFailureProgress({ ...run, activeDispatchIds: ['other'] }, state, evidenceStore), false);
});

test('patch coverage accepts the exact native partial-result transaction, never altered file claims or unrelated events', async () => {
  const run = { revision: 10, activeLeaseIds: ['l'], activeDispatchIds: ['d'] };
  const result = { status: 'blocked', failureClass: 'implementation-incomplete', changedFiles: ['src/owner'] };
  const body = { submissionId: 's', leaseId: 'l', dispatchId: 'd', featureId: 'f', agentId: 'a',
    inputSourceDigest: 'before', outputSourceDigest: 'after', changedFiles: ['src/owner'], result, evidenceRefs: ['e'] };
  const submission = { ...body, submissionDigest: digestJson(body) };
  const state = { projectId: 'p', runId: 'r', revision: 13, sourceDigest: 'after',
    features: [{ id: 'f', metadata: { stage: 'implementation' } }],
    leases: [{ leaseId: 'l', agentId: 'a', packetDigest: 'packet', runtimeReceipt: { hostSpawnReceipt: { effectId: 'effect' } } }],
    dispatches: [{ dispatchId: 'd', packetDigest: 'packet' }], submissions: [submission],
    events: [{ sequence: 11, type: 'lease.heartbeat', progress: 'terminal-failure-recovery', leaseId: 'l' },
      { sequence: 12, type: 'lease.heartbeat', progress: 'terminal-result-observed', leaseId: 'l' },
      { sequence: 13, type: 'submission.committed', status: 'blocked', featureId: 'f', submissionId: 's' }] };
  const record = { result, inputSourceDigest: 'before', outputSourceDigest: 'after', runtimeEvidence: {
    hostResultReceipt: { provider: 'codex-host', operation: 'result', agentId: 'a', dispatchId: 'd', effectId: 'effect',
      resultDigest: digestJson(result), observationRequestDigest: 'a'.repeat(64) } } };
  const evidenceStore = { read: async () => ({ metadata: { projectId: 'p', runId: 'r', featureId: 'f', dispatchId: 'd' },
    bytes: Buffer.from(JSON.stringify(record)) }) };
  assert.equal(await terminalFailureProgress(run, state, evidenceStore), true);
  assert.equal(await terminalFailureProgress(run, { ...state,
    events: state.events.map(event => ({ ...event, sequence: event.sequence + 1 })) }, evidenceStore), false);
  record.runtimeEvidence.hostResultReceipt.resultDigest = 'other';
  assert.equal(await terminalFailureProgress(run, state, evidenceStore), false);
  record.runtimeEvidence.hostResultReceipt.resultDigest = digestJson(result);
  record.result = { ...result, changedFiles: ['src/owner', 'cache'] };
  assert.equal(await terminalFailureProgress(run, state, evidenceStore), false);
});

test('patch coverage preserves an unchanged-source native provider failure and rejects unbound advances', async () => {
  const result = { status: 'failed', changedFiles: [], failureClass: 'runtime-provider',
    blocker: { kind: 'runtime-provider', code: 'CODEX_COLLABORATION_AGENT_FAILED' } };
  const terminalBody = { kind: 'host-terminal-failure-receipt', version: '1.0', agentId: 'a', dispatchId: 'd',
    packetDigest: 'packet', promptDigest: 'prompt', resultContractDigest: 'contract',
    nativeStatusDigest: digestJson({ errored: 'Selected model is at capacity.' }),
    observationRequestDigest: 'a'.repeat(64), code: result.blocker.code, resultDigest: digestJson(result) };
  const terminal = { ...terminalBody, receiptDigest: digestJson(terminalBody) };
  const body = { submissionId: 's', leaseId: 'l', dispatchId: 'd', featureId: 'f', agentId: 'a',
    inputSourceDigest: 'source', outputSourceDigest: 'source', changedFiles: [], result, evidenceRefs: ['e'] };
  const state = { projectId: 'p', runId: 'r', revision: 13, sourceDigest: 'source',
    features: [{ id: 'f', metadata: { stage: 'implementation' } }],
    leases: [{ leaseId: 'l', agentId: 'a', packetDigest: 'packet', runtimeReceipt: {
      resultContractDigest: 'contract', prompt: { promptDigest: 'prompt' }, hostSpawnReceipt: { effectId: 'effect' } } }],
    dispatches: [{ dispatchId: 'd', packetDigest: 'packet' }],
    submissions: [{ ...body, submissionDigest: digestJson(body) }],
    events: [{ sequence: 11, type: 'lease.heartbeat', progress: 'terminal-failure-recovery', leaseId: 'l' },
      { sequence: 12, type: 'lease.heartbeat', progress: 'terminal-result-observed', leaseId: 'l' },
      { sequence: 13, type: 'submission.committed', status: 'blocked', featureId: 'f', submissionId: 's' }] };
  const record = { result, inputSourceDigest: 'source', outputSourceDigest: 'source', runtimeEvidence: {
    hostTerminalFailure: terminal, hostResultReceipt: { provider: 'codex-host', operation: 'result', agentId: 'a',
      dispatchId: 'd', effectId: 'effect', terminalFailureDigest: terminal.receiptDigest,
      resultDigest: digestJson(result), observationRequestDigest: terminal.observationRequestDigest } } };
  const store = value => ({ read: async () => ({ metadata: { projectId: 'p', runId: 'r', featureId: 'f', dispatchId: 'd' },
    bytes: Buffer.from(JSON.stringify(value)) }) });
  assert.equal(await terminalFailureProgress({ revision: 10, activeLeaseIds: ['l'], activeDispatchIds: ['d'] }, state, store(record)), true);
  for (const change of [
    value => { delete value.runtimeEvidence.hostTerminalFailure; },
    value => { value.runtimeEvidence.resultRejection = {}; },
    value => { value.runtimeEvidence.hostResultReceipt.effectId = 'other'; },
    value => { value.runtimeEvidence.hostResultReceipt.observationRequestDigest = 'b'.repeat(64); },
    value => { value.runtimeEvidence.hostTerminalFailure.nativeStatusDigest = null; },
    value => { value.result = { ...result, changedFiles: ['invented/source'] }; },
  ]) {
    const altered = structuredClone(record); change(altered);
    assert.equal(await terminalFailureProgress({ revision: 10, activeLeaseIds: ['l'], activeDispatchIds: ['d'] }, state, store(altered)), false);
  }
  assert.equal(await terminalFailureProgress({ revision: 9, activeLeaseIds: ['l'], activeDispatchIds: ['d'] }, state, store(record)), false);
  const offsetState = { ...state, events: state.events.map(event => ({ ...event, sequence: event.sequence + 1 })) };
  assert.equal(await terminalFailureProgress({ revision: 10, eventSequence: 11,
    activeLeaseIds: ['l'], activeDispatchIds: ['d'] }, offsetState, store(record)), true);
  assert.equal(await terminalFailureProgress({ revision: 10, eventSequence: 10,
    activeLeaseIds: ['l'], activeDispatchIds: ['d'] }, offsetState, store(record)), false);
});
