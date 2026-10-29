import { digestJson } from '../common/canonical.mjs';
import { assert } from '../common/errors.mjs';

/** Only the adapter's original, settled native result may enter normal result validation. */
export const assertRecoverableNativeImplementationResult = ({ transported, effect, lease, dispatch, feature }) => {
  const receipt = transported?.receipt;
  const result = transported?.result;
  const evidence = transported?.runtimeEvidence;
  const nativePartial = result?.status === 'blocked' && result.changedFiles?.length > 0
    && !evidence?.hostTerminalFailure && !evidence?.resultRejection;
  const terminal = evidence?.hostTerminalFailure;
  const { receiptDigest, ...terminalBody } = terminal ?? {};
  const providerFailure = result?.status === 'failed' && result.failureClass === 'runtime-provider'
    && result.blocker?.kind === 'runtime-provider' && result.changedFiles?.length === 0
    && !evidence?.resultRejection
    && terminal?.kind === 'host-terminal-failure-receipt' && terminal.version === '1.0'
    && receiptDigest === digestJson(terminalBody)
    && terminal.agentId === lease.agentId && terminal.dispatchId === dispatch.dispatchId
    && terminal.packetDigest === dispatch.packetDigest
    && terminal.promptDigest === lease.runtimeReceipt?.prompt?.promptDigest
    && terminal.resultContractDigest === lease.runtimeReceipt?.resultContractDigest
    && terminal.code === result.blocker.code && terminal.resultDigest === digestJson(result)
    && /^[a-f0-9]{64}$/.test(terminal.nativeStatusDigest ?? '')
    && terminal.observationRequestDigest === receipt?.observationRequestDigest
    && receipt?.terminalFailureDigest === receiptDigest
    && effect.outcome?.terminalFailureDigest === receiptDigest;
  assert(feature?.metadata?.stage === 'implementation' && effect?.state === 'settled'
    && effect.outcome?.disposition === 'result-observed'
    && effect.canonicalAgentName === lease.agentId && effect.binding?.dispatchId === dispatch.dispatchId
    && effect.binding.packetDigest === dispatch.packetDigest
    && effect.binding.promptDigest === lease.runtimeReceipt?.prompt?.promptDigest
    && receipt?.provider === 'codex-host' && receipt.operation === 'result'
    && receipt.agentId === lease.agentId && receipt.dispatchId === dispatch.dispatchId
    && receipt.effectId === lease.runtimeReceipt?.hostSpawnReceipt?.effectId
    && receipt.resultDigest === effect.outcome.resultDigest && receipt.resultDigest === digestJson(result)
    && /^[a-f0-9]{64}$/.test(receipt.observationRequestDigest ?? '')
    && (nativePartial || providerFailure),
  'VISIBLE_DEVELOPMENT_RECOVERY_TERMINAL_UNVERIFIED',
  'Recovery requires the original settled native implementation result; normal changed-file and path checks still apply.');
};
