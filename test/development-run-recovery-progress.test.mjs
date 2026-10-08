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
      { sequence: 12, type: 'lease.heartbeat', progress: 'terminal-failure-recovery', leaseId: 'lease-1' },
      { sequence: 13, type: 'lease.heartbeat', progress: 'terminal-result-observed', leaseId: 'lease-1' },
      { sequence: 14, type: 'submission.committed', status: 'blocked', featureId: 'feature-f06', submissionId: 'submission-1' },
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
