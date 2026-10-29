import assert from 'node:assert/strict';
import test from 'node:test';
import { digestJson } from '../src/common/canonical.mjs';
import { assertRecoverableNativeImplementationResult } from '../src/application/development-terminal-result.mjs';

const fixture = () => {
  const result = { status: 'blocked', changedFiles: ['src/owner'], failureClass: 'implementation-incomplete' };
  const receipt = { provider: 'codex-host', operation: 'result', agentId: 'agent', dispatchId: 'dispatch',
    effectId: 'effect', resultDigest: digestJson(result), observationRequestDigest: 'a'.repeat(64) };
  return { feature: { metadata: { stage: 'implementation' } }, dispatch: { dispatchId: 'dispatch', packetDigest: 'packet' },
    lease: { agentId: 'agent', runtimeReceipt: { prompt: { promptDigest: 'prompt' }, hostSpawnReceipt: { effectId: 'effect' } } },
    effect: { state: 'settled', canonicalAgentName: 'agent', binding: { dispatchId: 'dispatch', packetDigest: 'packet', promptDigest: 'prompt' },
      outcome: { disposition: 'result-observed', resultDigest: receipt.resultDigest, observationRequestDigest: receipt.observationRequestDigest } },
    transported: { result, receipt, runtimeEvidence: {} } };
};

test('recovery accepts an unchanged native partial result only for normal exact-delta submission', () => {
  const args = fixture(); const before = structuredClone(args);
  assert.doesNotThrow(() => assertRecoverableNativeImplementationResult(args));
  assert.deepEqual(args, before);
  args.transported.receipt.observationRequestDigest = 'b'.repeat(64);
  assert.doesNotThrow(() => assertRecoverableNativeImplementationResult(args));
});

test('recovery rejects rewritten results, receipt substitution, completed claims and mismatched native identity', () => {
  for (const change of [
    args => { args.transported.result.changedFiles.push('unclaimed/cache'); },
    args => { args.transported.receipt.observationRequestDigest = 'invalid'; },
    args => { args.effect.binding.promptDigest = 'other'; },
    args => { args.transported.receipt.effectId = 'other'; },
    args => { args.transported.runtimeEvidence.resultRejection = {}; },
    args => { args.transported.result.status = 'completed'; },
    args => { args.effect.state = 'lease-bound'; },
  ]) {
    const args = fixture(); change(args);
    assert.throws(() => assertRecoverableNativeImplementationResult(args), { code: 'VISIBLE_DEVELOPMENT_RECOVERY_TERMINAL_UNVERIFIED' });
  }
});

const providerFixture = () => {
  const args = fixture();
  const result = { status: 'failed', failureClass: 'runtime-provider', changedFiles: [],
    blocker: { kind: 'runtime-provider', code: 'CODEX_COLLABORATION_AGENT_FAILED' } };
  args.lease.runtimeReceipt.resultContractDigest = 'contract';
  const terminalBody = { kind: 'host-terminal-failure-receipt', version: '1.0',
    agentId: 'agent', dispatchId: 'dispatch', packetDigest: 'packet', promptDigest: 'prompt',
    resultContractDigest: 'contract', code: result.blocker.code, resultDigest: digestJson(result),
    nativeStatusDigest: digestJson({ errored: 'Selected model is at capacity.' }),
    observationRequestDigest: args.transported.receipt.observationRequestDigest };
  const terminal = { ...terminalBody, receiptDigest: digestJson(terminalBody) };
  args.transported.result = result;
  args.transported.runtimeEvidence = { hostTerminalFailure: terminal };
  args.transported.receipt.resultDigest = digestJson(result);
  args.transported.receipt.terminalFailureDigest = terminal.receiptDigest;
  args.effect.outcome.resultDigest = digestJson(result);
  args.effect.outcome.terminalFailureDigest = terminal.receiptDigest;
  return args;
};

test('recovery accepts the exact native capacity failure without inventing source progress', () => {
  const args = providerFixture(); const before = structuredClone(args);
  assert.doesNotThrow(() => assertRecoverableNativeImplementationResult(args));
  assert.deepEqual(args, before);
});

test('provider recovery rejects incomplete or substituted terminal evidence', () => {
  for (const change of [
    args => { args.transported.runtimeEvidence.hostTerminalFailure = {}; },
    args => { args.transported.runtimeEvidence.resultRejection = {}; },
    args => { args.transported.runtimeEvidence.hostTerminalFailure.nativeStatusDigest = null; },
    args => { args.transported.runtimeEvidence.hostTerminalFailure.agentId = 'other'; },
    args => { args.transported.runtimeEvidence.hostTerminalFailure.resultContractDigest = 'other'; },
    args => { args.transported.receipt.terminalFailureDigest = 'other'; },
    args => { args.effect.outcome.terminalFailureDigest = 'other'; },
    args => { args.transported.result.failureClass = 'runtime-contract'; },
    args => { args.transported.result.blocker.kind = 'external-prerequisite'; },
  ]) {
    const args = providerFixture(); change(args);
    assert.throws(() => assertRecoverableNativeImplementationResult(args), { code: 'VISIBLE_DEVELOPMENT_RECOVERY_TERMINAL_UNVERIFIED' });
  }
});
