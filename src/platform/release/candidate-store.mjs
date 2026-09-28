import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assert } from '../../common/errors.mjs';
import { digestJson, sha256, withoutKeys } from '../../common/canonical.mjs';
import { assertNoLinkPath, safeSegment } from '../../common/paths.mjs';
import { captureWorkspace } from '../../common/workspace-snapshot.mjs';
import { atomicWrite, atomicWriteJson, readJson, withDirectoryLock } from '../../kernel/atomic-io.mjs';

const rootFor = (dataRoot, namespace, projectId, target) => resolve(dataRoot, safeSegment(namespace), safeSegment(projectId), safeSegment(target));
const statePath = root => resolve(root, 'state.json');
const candidatePath = (root, digest) => resolve(root, 'candidates', safeSegment(digest), 'candidate.json');
const digestPattern = /^[a-f0-9]{64}$/;

/** Version-neutral, content-addressed candidate storage. Business validation precedes this call. */
export const freezeReleaseCandidate = async ({ dataRoot, namespace, projectId, target, candidate, artifactRoot }) => {
  assert(candidate.candidateDigest === digestJson(withoutKeys(candidate, ['candidateDigest']))
    && candidate.projectId === projectId && candidate.target === target, 'RELEASE_CANDIDATE_DIGEST_MISMATCH', 'Candidate identity or digest is invalid.');
  const root = rootFor(dataRoot, namespace, projectId, target);
  await mkdir(root, { recursive: true });
  return withDirectoryLock(resolve(root, '.lock'), async () => {
    const previous = await readJson(statePath(root), { revision: 0, status: 'none', candidates: [], commands: {} });
    assert(previous.status !== 'released' || previous.candidateDigest === candidate.candidateDigest, 'RELEASE_ALREADY_FINAL', 'A different candidate cannot replace a released version.');
    const destination = resolve(root, 'candidates', candidate.candidateDigest);
    await mkdir(destination, { recursive: true });
    for (const artifact of candidate.artifacts) {
      const source = assertNoLinkPath(artifactRoot, resolve(artifactRoot, artifact.path), 'release package file');
      const targetFile = assertNoLinkPath(root, resolve(destination, 'artifacts', artifact.path), 'staged release artifact');
      let existing = null;
      try { existing = await readFile(targetFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (existing) assert(sha256(existing) === artifact.sha256, 'RELEASE_STAGED_ARTIFACT_DRIFT', `Staged artifact changed: ${artifact.path}`);
      else {
        const bytes = await readFile(source);
        assert(sha256(bytes) === artifact.sha256, 'RELEASE_ARTIFACT_CHANGED_DURING_STAGE', `Release artifact changed while staging: ${artifact.path}`);
        await atomicWrite(targetFile, bytes, { root });
      }
    }
    const manifestFile = candidatePath(root, candidate.candidateDigest);
    let existingCandidate = null;
    try { existingCandidate = await readJson(manifestFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existingCandidate) assert(digestJson(existingCandidate) === digestJson(candidate), 'RELEASE_CANDIDATE_DRIFT', 'Frozen candidate manifest changed.');
    else await atomicWriteJson(manifestFile, candidate, { root });
    if (previous.candidateDigest !== candidate.candidateDigest) {
      const next = { ...previous, revision: previous.revision + 1, status: 'prereleased', candidateDigest: candidate.candidateDigest, candidates: [...previous.candidates, candidate.candidateDigest] };
      await atomicWriteJson(statePath(root), next, { root });
    }
    return { candidate, file: manifestFile, state: await readJson(statePath(root)) };
  }, { root });
};

export const readReleaseCandidate = async ({ dataRoot, namespace, projectId, target }) => {
  const root = rootFor(dataRoot, namespace, projectId, target);
  const state = await readJson(statePath(root), { revision: 0, status: 'none', candidates: [], commands: {} });
  if (!state.candidateDigest) return { state, candidate: null };
  const candidate = await readJson(candidatePath(root, state.candidateDigest));
  assert(candidate.candidateDigest === digestJson(withoutKeys(candidate, ['candidateDigest'])), 'RELEASE_CANDIDATE_DIGEST_MISMATCH', 'Release candidate digest is invalid.');
  assert(candidate.projectId === projectId && candidate.target === target, 'RELEASE_CANDIDATE_SCOPE_MISMATCH', 'Release candidate belongs to another Project or target.');
  return { state, candidate };
};

/** Atomic, idempotent promotion of an exact frozen candidate; the Flow supplies its approval contract. */
export const promoteReleaseCandidate = async ({ dataRoot, namespace, project, target, workspaceRoot, candidateDigest, expectedRevision, commandId, approval, promotionKind }) => {
  assert(digestPattern.test(candidateDigest ?? '') && commandId && Number.isInteger(expectedRevision), 'RELEASE_PROMOTION_INPUT_INVALID', 'Promotion requires a candidate digest, command ID, and expected revision.');
  const root = rootFor(dataRoot, namespace, project.id, target);
  return withDirectoryLock(resolve(root, '.lock'), async () => {
    const { state, candidate } = await readReleaseCandidate({ dataRoot, namespace, projectId: project.id, target });
    const previousCommand = state.commands?.[commandId];
    if (previousCommand) {
      assert(previousCommand.candidateDigest === candidateDigest, 'COMMAND_ID_REUSED', 'Promotion command ID was reused for another candidate.');
      return { state, candidate, receipt: previousCommand };
    }
    assert(state.status === 'prereleased' && state.candidateDigest === candidateDigest && state.revision === expectedRevision, 'RELEASE_PROMOTION_STATE_MISMATCH', 'Promotion must target the current frozen prerelease revision.');
    const snapshot = await captureWorkspace(workspaceRoot, { excluded: project.workspace.excluded ?? [] });
    assert(snapshot.digest === candidate.sourceDigest, 'RELEASE_PROMOTION_SOURCE_DRIFT', 'Promotion cannot change or rebuild the frozen source.');
    for (const artifact of candidate.artifacts) {
      const file = assertNoLinkPath(root, resolve(root, 'candidates', candidateDigest, 'artifacts', artifact.path), 'frozen release artifact');
      assert(sha256(await readFile(file)) === artifact.sha256, 'RELEASE_PROMOTION_ARTIFACT_DRIFT', `Frozen artifact changed: ${artifact.path}`);
    }
    const receiptBody = { protocolVersion: '1.0', kind: promotionKind, projectId: project.id, target,
      candidateDigest, commandId, fromRevision: state.revision, toRevision: state.revision + 1,
      approval: structuredClone(approval), releasedAt: new Date().toISOString() };
    const receipt = { ...receiptBody, receiptDigest: digestJson(receiptBody) };
    const next = { ...state, revision: state.revision + 1, status: 'released', releasedAt: receipt.releasedAt,
      commands: { ...state.commands, [commandId]: receipt } };
    await atomicWriteJson(resolve(root, 'promotions', `${safeSegment(receipt.receiptDigest)}.json`), receipt, { root });
    await atomicWriteJson(statePath(root), next, { root });
    return { state: next, candidate, receipt };
  }, { root });
};
