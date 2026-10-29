import { digestJson, withoutKeys } from '../common/canonical.mjs';
import { assert } from '../common/errors.mjs';

const interruptedCode = 'CODEX_COLLABORATION_AGENT_INTERRUPTED';
const digest = value => /^[a-f0-9]{64}$/.test(value ?? '');

// This is only a candidate. The original Host evidence must also be read below.
export const isInterruptedImplementationSubmission = (state, feature, submission) => Boolean(
  feature?.metadata?.stage === 'implementation' && submission?.result?.status === 'failed'
  && submission.result.failureClass === 'runtime-interrupted'
  && submission.result.blocker?.kind === 'runtime-interrupted'
  && submission.result.blocker.code === interruptedCode
  && submission.changedFiles?.length === 0 && submission.result.changedFiles?.length === 0
  && digest(submission.inputSourceDigest) && submission.inputSourceDigest === submission.outputSourceDigest
  && submission.outputSourceDigest === state.sourceDigest && submission.evidenceRefs?.length === 1);

export const verifyInterruptedImplementationResume = async ({ state, feature, submission, evidenceStore }) => {
  if (submission?.result?.failureClass !== 'runtime-interrupted') return;
  const valid = condition => assert(condition, 'LIFECYCLE_RESUME_INTERRUPTION_UNVERIFIED',
    'Interrupted implementation requires the unchanged source and its original bound native terminal evidence.');
  valid(isInterruptedImplementationSubmission(state, feature, submission)
    && submission.submissionDigest === digestJson(withoutKeys(submission, ['submissionDigest']))
    && !state.leases.some(item => ['requested', 'active'].includes(item.status))
    && !state.dispatches.some(item => ['requested', 'assigned'].includes(item.status)));
  const lease = state.leases.find(item => item.leaseId === submission.leaseId);
  const dispatch = state.dispatches.find(item => item.dispatchId === submission.dispatchId);
  const spawn = lease?.runtimeReceipt?.hostSpawnReceipt;
  valid(lease?.status === 'committed' && dispatch?.status === 'committed'
    && lease.dispatchId === dispatch.dispatchId && dispatch.featureId === feature.id
    && lease.agentId === submission.agentId && lease.packetDigest === dispatch.packetDigest
    && spawn?.agentId === lease.agentId && spawn.dispatchId === dispatch.dispatchId
    && spawn.packetDigest === dispatch.packetDigest
    && spawn.promptDigest === lease.runtimeReceipt?.prompt?.promptDigest
    && digest(lease.runtimeReceipt?.resultContractDigest)
    && lease.epoch === dispatch.epoch && lease.generation === dispatch.generation);
  const evidence = await evidenceStore.read(submission.evidenceRefs[0]);
  const record = JSON.parse(evidence.bytes.toString('utf8'));
  const terminal = record.runtimeEvidence?.hostTerminalFailure;
  const receipt = record.runtimeEvidence?.hostResultReceipt;
  const resultDigest = digestJson(submission.result);
  valid(evidence.metadata.projectId === state.projectId && evidence.metadata.runId === state.runId
    && evidence.metadata.featureId === feature.id && evidence.metadata.dispatchId === dispatch.dispatchId
    && evidence.metadata.epoch === lease.epoch && evidence.metadata.generation === lease.generation
    && evidence.metadata.sourceDigest === submission.inputSourceDigest
    && record.inputSourceDigest === submission.inputSourceDigest
    && record.outputSourceDigest === submission.outputSourceDigest
    && digestJson(record.result) === resultDigest && !record.runtimeEvidence?.resultRejection
    && terminal?.kind === 'host-terminal-failure-receipt' && terminal.version === '1.0'
    && terminal.receiptDigest === digestJson(withoutKeys(terminal, ['receiptDigest']))
    && terminal.code === interruptedCode && terminal.nativeStatusDigest === digestJson('interrupted')
    && terminal.agentId === lease.agentId && terminal.dispatchId === dispatch.dispatchId
    && terminal.packetDigest === dispatch.packetDigest && terminal.promptDigest === spawn.promptDigest
    && terminal.resultContractDigest === lease.runtimeReceipt.resultContractDigest
    && terminal.resultDigest === resultDigest && digest(terminal.observationRequestDigest)
    && receipt?.provider === 'codex-host' && receipt.operation === 'result'
    && receipt.agentId === lease.agentId && receipt.dispatchId === dispatch.dispatchId
    && receipt.effectId === spawn.effectId && receipt.resultDigest === resultDigest
    && receipt.observationRequestDigest === terminal.observationRequestDigest
    && receipt.terminalFailureDigest === terminal.receiptDigest && !receipt.rejectionDigest);
};
