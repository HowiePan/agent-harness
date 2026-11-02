import { assert } from '../common/errors.mjs';
import { digestJson } from '../common/canonical.mjs';

// This is a preserved draft input, never a Submission or completion certificate.
export const verifyUnacceptedAmendmentBaseline = async (prior, baseline, evidenceStore) => {
  const terminal = prior.metadata?.unacceptedTerminalResult;
  const evidence = await evidenceStore.read(baseline.snapshotEvidenceRef);
  const record = JSON.parse(evidence.bytes.toString('utf8'));
  const dispatch = prior.dispatches.find(item => item.dispatchId === terminal?.dispatchId);
  const output = record.sourceDelta?.observedSnapshot;
  assert(prior.status === 'failed' && prior.metadata?.terminalOutcome?.reason === 'unaccepted-terminal-result-for-replan'
    && terminal?.evidenceRef === baseline.snapshotEvidenceRef && prior.evidenceRefs.includes(baseline.snapshotEvidenceRef)
    && dispatch?.status === 'superseded' && !prior.submissions.some(item => item.dispatchId === dispatch.dispatchId)
    && evidence.metadata.projectId === prior.projectId && evidence.metadata.runId === prior.runId
    && evidence.metadata.epoch === prior.epoch && evidence.metadata.generation === prior.generation
    && evidence.metadata.featureId === dispatch.featureId && evidence.metadata.dispatchId === dispatch.dispatchId
    && evidence.metadata.sourceDigest === prior.sourceDigest && evidence.metadata.artifactDigest === prior.artifactDigest
    && evidence.metadata.policyDigest === prior.policyDigest && evidence.metadata.pluginSetDigest === prior.pluginSetDigest
    && record.kind === 'unaccepted-terminal-result-retirement' && record.version === '1.0'
    && record.originalResultDigest === terminal.resultDigest && digestJson(record.originalResult) === terminal.resultDigest
    && record.hostObservationReceipt?.receiptDigest === terminal.hostReceiptDigest
    && record.sourceDelta?.fromSourceDigest === prior.sourceDigest
    && record.sourceDelta.unclaimedChangedPaths?.length === 0
    && output?.root === prior.metadata.workspace.root && output.digest === record.sourceDelta.observedSourceDigest
    && digestJson(output.files) === output.digest
    && digestJson(output) === digestJson(baseline.outputSnapshot),
  'PLAN_AMENDMENT_BASELINE_EVIDENCE_INVALID', 'An unaccepted draft baseline requires exact retirement Evidence, original native result and attributed source snapshot.');
  return output;
};
