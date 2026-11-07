import { resolve } from 'node:path';
import { canonicalize, digestJson, sha256 } from '../common/canonical.mjs';
import { assert } from '../common/errors.mjs';
import { assertNoLinkPath, safeSegment } from '../common/paths.mjs';
import { atomicWrite } from '../kernel/atomic-io.mjs';
import { readVerifiedRunRecord } from './authority-history-reader.mjs';

/** Follow declared Authority ancestry only, one Run at a time; never scan a data root. */
export const collectImplementationDraftInputs = async ({ state, feature, authorityStore, evidenceStore }) => {
  if (!feature.metadata?.deliveryBatch || !state.metadata?.approvedPlan?.runId) return [];
  const queue = [state.metadata.approvedPlan.runId];
  const visited = new Set([state.runId]);
  const inputs = new Map();
  while (queue.length) {
    const runId = queue.shift();
    if (visited.has(runId)) continue;
    assert(visited.size < 64, 'IMPLEMENTATION_EVIDENCE_LINEAGE_LIMIT', 'Evidence ancestry exceeds the bounded inspection limit.');
    visited.add(runId);
    const prior = await readVerifiedRunRecord(authorityStore, state.projectId, runId);
    assert(prior.projectId === state.projectId && prior.runId === runId,
      'IMPLEMENTATION_EVIDENCE_IDENTITY_MISMATCH', 'Required evidence ancestry belongs to another project or Run.');
    const terminal = prior.metadata?.unacceptedTerminalResult;
    const dispatch = prior.dispatches?.find(item => item.dispatchId === terminal?.dispatchId);
    const owner = prior.features?.find(item => item.id === dispatch?.featureId);
    if (terminal && owner?.logicalRoot === feature.logicalRoot) {
      const record = await evidenceStore.read(terminal.evidenceRef);
      const value = JSON.parse(record.bytes.toString('utf8'));
      const snapshot = value.sourceDelta?.observedSnapshot;
      assert(record.metadata.projectId === state.projectId && record.metadata.runId === prior.runId
        && record.metadata.dispatchId === dispatch.dispatchId && record.metadata.featureId === owner.id
        && record.metadata.sourceDigest === prior.sourceDigest
        && prior.status === 'failed' && dispatch.status === 'superseded'
        && record.metadata.epoch === prior.epoch && record.metadata.generation === prior.generation
        && record.metadata.artifactDigest === prior.artifactDigest && record.metadata.policyDigest === prior.policyDigest
        && record.metadata.pluginSetDigest === prior.pluginSetDigest
        && value.kind === 'unaccepted-terminal-result-retirement' && value.version === '1.0'
        && value.originalResultDigest === terminal.resultDigest && digestJson(value.originalResult) === terminal.resultDigest
        && value.hostObservationReceipt?.receiptDigest === terminal.hostReceiptDigest
        && snapshot?.digest === digestJson(snapshot.files)
        && snapshot.digest === value.sourceDelta.observedSourceDigest
        && !prior.submissions.some(item => item.dispatchId === dispatch.dispatchId),
      'IMPLEMENTATION_DRAFT_EVIDENCE_INVALID', 'A draft input requires original unaccepted native bytes, Host identity and attributed source evidence.');
      const { observedSnapshot: _snapshot, ...sourceDelta } = value.sourceDelta;
      inputs.set(terminal.evidenceRef, { kind: 'implementation-draft-input', version: '1.0',
        projectId: state.projectId, originRunId: prior.runId, featureId: owner.id,
        evidenceRef: terminal.evidenceRef, evidenceSha256: sha256(record.bytes), resultDigest: terminal.resultDigest,
        completionCredit: false, status: 'unaccepted', originalResult: value.originalResult, sourceDelta });
      assert(inputs.size <= 8, 'IMPLEMENTATION_EVIDENCE_INPUT_LIMIT', 'Split excessive historical evidence inputs before dispatch.');
      // The nearest explicitly linked draft is the current development input;
      // older ancestors are audit history, never additional acceptance credit.
      break;
    }
    const revision = prior.metadata?.planRevision;
    for (const id of [prior.metadata?.approvedPlan?.runId, revision?.parentRunId,
      ...(revision?.implementationBaselines ?? []).map(item => item.runId)]) if (id && !visited.has(id)) queue.push(id);
  }
  return [...inputs.values()];
};

export const prepareImplementationEvidenceInputs = async options => {
  const { state, evidenceStore } = options;
  const values = await collectImplementationDraftInputs(options);
  for(const repair of state.metadata?.dependencyRepairs??[])if(repair.status==='pending'&&repair.ownerFeatureId===options.feature.id){
    const review=state.submissions.find(s=>s.submissionId===repair.reviewSubmissionId);
    const source=state.submissions.find(s=>s.submissionId===repair.sourceSubmissionId);
    assert(review&&source,'DEPENDENCY_REPAIR_INPUT_MISSING','Dependency return must retain its original diagnosis and blocker.');
    values.push({kind:'dependency-repair-input',version:'1.0',projectId:state.projectId,originRunId:repair.originRunId,
      evidenceRef:repair.assessmentRef,completionCredit:false,status:'unaccepted',repair,
      blocker:source.result,diagnosis:review.result.outputs.diagnosis.value});
  }
  const refs = [];
  for (const value of values) {
    const bytes = Buffer.from(canonicalize(value));
    assert(bytes.length <= 256 * 1024, 'IMPLEMENTATION_EVIDENCE_INPUT_LIMIT', 'Historical draft context must remain a bounded artifact.');
    const digest = sha256(bytes);
    const path = assertNoLinkPath(evidenceStore.root, resolve(evidenceStore.root, 'outputs', safeSegment(state.projectId),
      safeSegment(state.runId), 'inputs', `${digest}.json`), 'required implementation evidence');
    await atomicWrite(path, bytes, { root: evidenceStore.root });
    refs.push({ kind: value.kind, path, sha256: digest, size: bytes.length, evidenceRef: value.evidenceRef,
      originRunId: value.originRunId, status: 'unaccepted', completionCredit: false, access: 'read-only' });
  }
  return refs;
};
