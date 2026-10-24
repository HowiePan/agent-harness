import { assert } from '../common/errors.mjs';
import { digestJson, withoutKeys } from '../common/canonical.mjs';

/** Recover only exact planning bytes already committed by a blocked draft, never an artifact-root wildcard. */
export const verifyBlockedDraftArtifacts = async ({ drafts, snapshot, evidenceStore, artifactRoot }) => {
  const current = new Map(snapshot.files.map(file => [file.path, file]));
  const verified = new Set();
  for (const draft of drafts) for (const submission of draft.submissions.filter(row => !row.supersededAt && row.changedFiles?.length)) {
    const dispatch = draft.dispatches.find(row => row.dispatchId === submission.dispatchId);
    const invalid = 'PLAN_AMENDMENT_DRAFT_ARTIFACT_INVALID';
    assert(submission.result?.status === 'blocked' && submission.result.failureClass === 'scope-blocker'
      && submission.submissionDigest === digestJson(withoutKeys(submission, ['submissionDigest']))
      && dispatch?.status === 'committed' && dispatch.submissionId === submission.submissionId
      && dispatch.featureSnapshot.metadata?.stage === 'version-planning'
      && submission.changedFiles.every(path => path.startsWith(`${artifactRoot}/`)),
    invalid, 'Draft artifact must belong to a committed scope-blocked planning Submission.');
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
