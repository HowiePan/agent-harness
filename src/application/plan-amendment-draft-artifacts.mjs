import { assert } from '../common/errors.mjs';
import { digestJson, withoutKeys } from '../common/canonical.mjs';
import { rejectedAmendmentDraftEvidence } from './plan-amendment-retry.mjs';

/** Recover only exact planning bytes already committed by a blocked draft, never an artifact-root wildcard. */
export const verifyBlockedDraftArtifacts = async ({ drafts, snapshot, evidenceStore, artifactRoot }) => {
  const current = new Map(snapshot.files.map(file => [file.path, file]));
  const verified = new Set();
  for (const draft of drafts) {
    const rejected = rejectedAmendmentDraftEvidence(draft);
    if (!rejected) continue;
    const review = rejected.review;
    const dispatch = draft.dispatches.find(row => row.dispatchId === review.dispatchId);
    const records = await Promise.all(review.evidenceRefs.map(ref => evidenceStore.read(ref)));
    assert(review.changedFiles?.length === 0 && review.inputSourceDigest === review.outputSourceDigest
      && dispatch.featureSnapshot.metadata?.stage === 'plan-review'
      && records.some(record => {
        const value = JSON.parse(record.bytes.toString('utf8'));
        return record.metadata.projectId === draft.projectId && record.metadata.runId === draft.runId
          && record.metadata.featureId === review.featureId && record.metadata.dispatchId === review.dispatchId
          && value.sourceSnapshotRef === dispatch.sourceSnapshotRef
          && value.inputSourceDigest === review.inputSourceDigest && value.outputSourceDigest === review.outputSourceDigest
          && digestJson(value.result) === digestJson(review.result);
      }), 'PLAN_AMENDMENT_DRAFT_ARTIFACT_INVALID', 'Rejected review requires its exact committed read-only Evidence.');
  }
  for (const draft of drafts.filter(item => item.metadata?.unacceptedPlanningResult)) {
    const saved = draft.metadata.unacceptedPlanningResult;
    const evidence = await evidenceStore.read(saved.evidenceRef);
    const record = JSON.parse(evidence.bytes.toString('utf8'));
    const dispatch = draft.dispatches.find(row => row.sourceSnapshotRef === record.sourceSnapshotRef);
    assert(record.kind === 'unaccepted-planning-output' && record.version === '1.0'
      && evidence.metadata.projectId === draft.projectId && evidence.metadata.runId === draft.runId
      && evidence.metadata.epoch === draft.epoch && evidence.metadata.generation === draft.generation
      && evidence.metadata.artifactDigest === draft.artifactDigest && evidence.metadata.sourceDigest === draft.sourceDigest
      && evidence.metadata.dispatchId === dispatch?.dispatchId && dispatch.status === 'superseded'
      && evidence.metadata.featureId === dispatch.featureId
      && dispatch.featureSnapshot.metadata?.stage === 'version-planning'
      && record.originalResultDigest === saved.originalResultDigest && digestJson(record.originalResult) === saved.originalResultDigest
      && record.originalResult.status === 'completed' && record.originalResult.outputs?.amendment?.value?.deltaRef
      && !record.originalResult.outputs.amendment.value.plan
      && digestJson(record.originalResult.outputs.amendment.value.deltaRef) === digestJson(saved.deltaRef)
      && record.patchReceiptDigest === saved.patchReceiptDigest
      && record.outputSnapshot.digest === saved.observedSourceDigest
      && record.outputSnapshot.root === snapshot.root && digestJson(record.outputSnapshot.files) === saved.observedSourceDigest
      && record.rejection.code === 'RESULT_OUTPUT_BUDGET_EXCEEDED' && record.rejection.expandedBytes > 256 * 1024
      && digestJson([...new Set(record.originalResult.changedFiles)].sort()) === digestJson(record.changedFiles)
      && record.changedFiles.every(path => path.startsWith(`${artifactRoot}/`)),
    'PLAN_AMENDMENT_DRAFT_ARTIFACT_INVALID', 'Preserved planning artifacts require their original native result and scoped snapshot evidence.');
    const inputEvidence = await evidenceStore.read(record.sourceSnapshotRef);
    const before = JSON.parse(inputEvidence.bytes.toString('utf8'));
    assert(inputEvidence.metadata.projectId === draft.projectId && inputEvidence.metadata.runId === draft.runId
      && inputEvidence.metadata.sourceDigest === draft.sourceDigest && before.digest === draft.sourceDigest
      && digestJson(before.files) === before.digest && before.root === snapshot.root,
    'PLAN_AMENDMENT_DRAFT_ARTIFACT_INVALID', 'Preserved planning input must bind the retired transport source.');
    const files = new Map(before.files.map(file => [file.path, file]));
    for (const path of record.changedFiles) { if (current.has(path)) files.set(path, current.get(path)); else files.delete(path); }
    assert(digestJson([...files.values()].sort((a, b) => a.path.localeCompare(b.path))) === saved.observedSourceDigest,
      'PLAN_AMENDMENT_DRAFT_ARTIFACT_CHANGED', 'Preserved native draft bytes changed after retirement.');
    for (const path of record.changedFiles) verified.add(path);
  }
  for (const draft of drafts) for (const submission of draft.submissions.filter(row => !row.supersededAt && row.changedFiles?.length)) {
    const dispatch = draft.dispatches.find(row => row.dispatchId === submission.dispatchId);
    const invalid = 'PLAN_AMENDMENT_DRAFT_ARTIFACT_INVALID';
    const rejected = rejectedAmendmentDraftEvidence(draft);
    const rejectedResult = rejected && [rejected.planner.submissionId, rejected.blocked.submissionId].includes(submission.submissionId);
    assert((submission.result?.status === 'blocked' && submission.result.failureClass === 'scope-blocker' || rejectedResult)
      && submission.submissionDigest === digestJson(withoutKeys(submission, ['submissionDigest']))
      && dispatch?.status === 'committed' && dispatch.submissionId === submission.submissionId
      && dispatch.featureSnapshot.metadata?.stage === 'version-planning'
      && submission.changedFiles.every(path => path.startsWith(`${artifactRoot}/`)),
    invalid, 'Draft artifact must belong to a committed unapproved blocked planning chain.');
    const records = await Promise.all(submission.evidenceRefs.map(ref => evidenceStore.read(ref)));
    assert(records.some(record => {
      const payload = JSON.parse(record.bytes.toString('utf8'));
      return record.metadata.projectId === draft.projectId && record.metadata.runId === draft.runId
        && record.metadata.dispatchId === submission.dispatchId && record.metadata.featureId === submission.featureId
        && record.metadata.sourceDigest === submission.inputSourceDigest
        && payload.inputSourceDigest === submission.inputSourceDigest && payload.outputSourceDigest === submission.outputSourceDigest
        && payload.sourceSnapshotRef === dispatch.sourceSnapshotRef && digestJson(payload.result) === digestJson(submission.result);
    }), invalid, 'Draft artifact requires the original Submission Evidence and source commitment.');
    const source = await evidenceStore.read(dispatch.sourceSnapshotRef);
    const before = JSON.parse(source.bytes.toString('utf8'));
    assert(source.metadata.projectId === draft.projectId && source.metadata.runId === draft.runId
      && source.metadata.sourceDigest === submission.inputSourceDigest
      && before.digest === submission.inputSourceDigest && digestJson(before.files) === before.digest,
    invalid, 'Draft input snapshot does not bind its immutable source.');
    const reconstructed = new Map(before.files.map(file => [file.path, file]));
    for (const path of submission.changedFiles) {
      if (current.has(path)) reconstructed.set(path, current.get(path));
      else reconstructed.delete(path);
    }
    const files = [...reconstructed.values()].sort((a, b) => a.path.localeCompare(b.path));
    assert(digestJson(files) === submission.outputSourceDigest,
      'PLAN_AMENDMENT_DRAFT_ARTIFACT_CHANGED', 'Draft artifact bytes differ from the committed output snapshot.');
    for (const path of submission.changedFiles) verified.add(path);
  }
  return verified;
};
