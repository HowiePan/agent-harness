import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assert, fail } from '../../common/errors.mjs';
import { canonicalize, digestJson, sha256, withoutKeys } from '../../common/canonical.mjs';
import { assertNoLinkPath, safeSegment } from '../../common/paths.mjs';
import { captureWorkspace } from '../../common/workspace-snapshot.mjs';

const runFile = promisify(execFile);
const oidPattern = /^[a-f0-9]{40,64}$/;
const releaseRef = (projectId, target) => `refs/tags/harness/${safeSegment(projectId)}/${safeSegment(target)}`;

const git = async (root, args, code) => {
  try {
    const { stdout } = await runFile('git', ['-C', root, ...args], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    return stdout;
  } catch (error) {
    // Git diagnostics can contain credential-bearing remote URLs. Never propagate stderr.
    fail(code, `Git release operation failed (${args[0]}).`);
  }
};

const localTagOid = async (root, ref) => {
  try {
    await runFile('git', ['-C', root, 'show-ref', '--quiet', '--verify', ref], { windowsHide: true });
  } catch (error) {
    if (error.code === 1) return null;
    fail('RELEASE_GIT_TAG_READ_FAILED', 'Could not read the local release tag.');
  }
  return (await git(root, ['show-ref', '--verify', '--hash', ref], 'RELEASE_GIT_TAG_READ_FAILED')).toString('utf8').trim();
};

const remoteTagOid = async (root, remote, ref) => {
  const output = (await git(root, ['ls-remote', '--refs', remote, ref], 'RELEASE_GIT_REMOTE_UNAVAILABLE')).toString('utf8').trim();
  if (!output) return null;
  const [oid, returnedRef] = output.split(/\s+/);
  assert(oidPattern.test(oid) && returnedRef === ref, 'RELEASE_GIT_REMOTE_TAG_INVALID', 'Remote returned an invalid release tag reference.');
  return oid;
};

const readLocalTag = async (root, ref) => {
  const tagOid = await localTagOid(root, ref);
  if (!tagOid) return null;
  const tag = (await git(root, ['cat-file', '-p', tagOid], 'RELEASE_GIT_TAG_READ_FAILED')).toString('utf8');
  const split = tag.indexOf('\n\n');
  assert(split > 0, 'RELEASE_GIT_TAG_INVALID', 'Release tag has no attestation body.');
  const header = tag.slice(0, split);
  const object = header.match(/^object ([a-f0-9]{40,64})$/m)?.[1];
  assert(header.includes('type commit\n') && object, 'RELEASE_GIT_TAG_INVALID', 'Release tag must point directly to a commit.');
  let record;
  try { record = JSON.parse(tag.slice(split + 2)); }
  catch { fail('RELEASE_GIT_TAG_INVALID', 'Release tag attestation is not JSON.'); }
  return { tagOid, commit: object, record };
};

const validateRecord = ({ record, commit, projectId, target }) => {
  assert(record?.protocolVersion === '1.0' && record.kind === 'git-version-release'
    && record.projectId === projectId && record.target === target && record.commit === commit
    && record.recordDigest === digestJson(withoutKeys(record, ['recordDigest'])),
  'RELEASE_GIT_RECORD_INVALID', 'Release tag attestation identity or digest is invalid.');
  const { candidate, receipt } = record;
  assert(candidate?.kind === 'version-release-candidate' && candidate.status === 'prereleased'
    && oidPattern.test(commit) && /^[a-f0-9]{64}$/.test(candidate.sourceDigest ?? '')
    && Array.isArray(candidate.artifacts) && candidate.artifacts.length > 0
    && candidate.artifacts.every(item => /^[a-f0-9]{64}$/.test(item.sha256 ?? ''))
    && candidate.candidateDigest === digestJson(withoutKeys(candidate, ['candidateDigest']))
    && candidate.projectId === projectId && candidate.target === target
    && receipt?.receiptDigest === digestJson(withoutKeys(receipt, ['receiptDigest']))
    && receipt.kind === 'version-release-promotion' && receipt.projectId === projectId && receipt.target === target
    && receipt.candidateDigest === candidate.candidateDigest && receipt.approval?.id === 'formal-version-release'
    && receipt.approval?.actor && receipt.approval.actor !== 'project-local-invocation'
    && receipt.approval?.decision === 'approved' && receipt.approval?.projectId === projectId
    && receipt.approval?.target === target && receipt.approval?.candidateDigest === candidate.candidateDigest,
  'RELEASE_GIT_RECORD_INVALID', 'Release candidate or formal approval is invalid.');
};

/** Verify an immutable Git attestation against its remote tag and committed package bytes. */
export const verifyGitVersionRelease = async ({ workspaceRoot, projectId, target, remote = 'origin' }) => {
  const ref = releaseRef(projectId, target);
  const local = await readLocalTag(workspaceRoot, ref);
  if (!local) return null;
  validateRecord({ record: local.record, commit: local.commit, projectId, target });
  const remoteOid = await remoteTagOid(workspaceRoot, safeSegment(remote, 'Git remote'), ref);
  assert(remoteOid === local.tagOid, 'RELEASE_GIT_REMOTE_MISMATCH', 'Remote release tag is missing or differs from the local tag.');
  for (const artifact of local.record.candidate.artifacts) {
    const path = `${local.record.candidate.artifactRoot}/${artifact.path}`.replaceAll('\\', '/');
    assert(!path.startsWith('/') && !path.split('/').some(part => !part || part === '.' || part === '..'),
      'RELEASE_GIT_ARTIFACT_PATH_INVALID', 'Release artifact path is invalid.');
    const bytes = await git(workspaceRoot, ['show', `${local.commit}:${path}`], 'RELEASE_GIT_ARTIFACT_NOT_COMMITTED');
    assert(sha256(bytes) === artifact.sha256, 'RELEASE_GIT_ARTIFACT_MISMATCH', `Committed release artifact differs: ${artifact.path}`);
  }
  return { ref, tagOid: local.tagOid, commit: local.commit, record: local.record, remoteVerified: true };
};

/** Publish an already approved version. Safe to retry after a push or local-state interruption. */
export const publishGitVersionRelease = async ({ workspaceRoot, temporaryRoot, project, target, candidate, receipt, remote = 'origin' }) => {
  const projectId = project.id;
  const ref = releaseRef(projectId, target);
  const actualRoot = (await git(workspaceRoot, ['rev-parse', '--show-toplevel'], 'RELEASE_GIT_REPOSITORY_REQUIRED')).toString('utf8').trim();
  assert(resolve(actualRoot).toLowerCase() === resolve(workspaceRoot).toLowerCase(), 'RELEASE_GIT_ROOT_MISMATCH', 'Release workspace must be the Git repository root.');
  const status = (await git(workspaceRoot, ['status', '--porcelain', '--untracked-files=all'], 'RELEASE_GIT_STATUS_FAILED')).toString('utf8');
  assert(!status.trim(), 'RELEASE_GIT_DIRTY', 'Formal Git release requires a clean committed workspace.');
  const snapshot = await captureWorkspace(workspaceRoot, { excluded: project.workspace.excluded ?? [] });
  assert(snapshot.digest === candidate.sourceDigest, 'RELEASE_GIT_SOURCE_DRIFT', 'Committed workspace differs from the frozen release candidate.');
  const commit = (await git(workspaceRoot, ['rev-parse', 'HEAD'], 'RELEASE_GIT_HEAD_FAILED')).toString('utf8').trim();
  assert(oidPattern.test(commit), 'RELEASE_GIT_HEAD_INVALID', 'Release HEAD is not a commit ID.');
  for (const artifact of candidate.artifacts) {
    const path = `${candidate.artifactRoot}/${artifact.path}`.replaceAll('\\', '/');
    assert(!path.startsWith('/') && !path.split('/').some(part => !part || part === '.' || part === '..'),
      'RELEASE_GIT_ARTIFACT_PATH_INVALID', 'Release artifact path is invalid.');
    const bytes = await git(workspaceRoot, ['show', `${commit}:${path}`], 'RELEASE_GIT_ARTIFACT_NOT_COMMITTED');
    assert(sha256(bytes) === artifact.sha256, 'RELEASE_GIT_ARTIFACT_MISMATCH', `Committed release artifact differs: ${artifact.path}`);
  }
  validateRecord({ record: { protocolVersion: '1.0', kind: 'git-version-release', projectId, target, commit, candidate, receipt,
    recordDigest: digestJson({ protocolVersion: '1.0', kind: 'git-version-release', projectId, target, commit, candidate, receipt }) }, commit, projectId, target });
  const body = { protocolVersion: '1.0', kind: 'git-version-release', projectId, target, commit, candidate, receipt };
  const record = { ...body, recordDigest: digestJson(body) };
  const current = await readLocalTag(workspaceRoot, ref);
  if (current) {
    assert(current.commit === commit && canonicalize(current.record) === canonicalize(record),
      'RELEASE_GIT_TAG_CONFLICT', 'Existing local release tag binds different release evidence.');
  } else {
    const temporary = await mkdtemp(assertNoLinkPath(temporaryRoot, resolve(temporaryRoot, 'harness-release-tag-'), 'release tag temporary directory'));
    try {
      const message = resolve(temporary, 'message.json');
      await writeFile(message, `${canonicalize(record)}\n`);
      await git(workspaceRoot, ['-c', 'user.name=Agent Harness', '-c', 'user.email=agent-harness@invalid', 'tag', '-a', '-F', message, ref.slice('refs/tags/'.length), commit], 'RELEASE_GIT_TAG_CREATE_FAILED');
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  const tagOid = await localTagOid(workspaceRoot, ref);
  const remoteName = safeSegment(remote, 'Git remote');
  const existingRemote = await remoteTagOid(workspaceRoot, remoteName, ref);
  assert(!existingRemote || existingRemote === tagOid, 'RELEASE_GIT_REMOTE_CONFLICT', 'Remote release tag already points to different evidence.');
  if (!existingRemote) await git(workspaceRoot, ['push', remoteName, `${ref}:${ref}`], 'RELEASE_GIT_PUSH_FAILED');
  return verifyGitVersionRelease({ workspaceRoot, projectId, target, remote: remoteName });
};
