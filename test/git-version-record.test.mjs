import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { harnessTemporaryRoot } from '../src/common/write-boundary.mjs';
import { digestJson, sha256 } from '../src/common/canonical.mjs';
import { captureWorkspace } from '../src/common/workspace-snapshot.mjs';
import { publishGitVersionRelease, verifyGitVersionRelease } from '../src/platform/release/git-version-record.mjs';
import { publishVersionRelease, readPortableVersionRelease } from '../src/application/version-prerelease.mjs';

const run = promisify(execFile);
const git = async (cwd, ...args) => run('git', args, { cwd, windowsHide: true });

const fixture = async t => {
  await mkdir(harnessTemporaryRoot(), { recursive: true });
  const root = await mkdtemp(resolve(harnessTemporaryRoot(), 'git-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = resolve(root, 'workspace');
  const remote = resolve(root, 'remote.git');
  await mkdir(workspaceRoot);
  await git(root, 'init', '--bare', remote);
  await git(root, 'init', workspaceRoot);
  await git(workspaceRoot, 'config', 'user.name', 'Fixture');
  await git(workspaceRoot, 'config', 'user.email', 'fixture@example.invalid');
  await git(workspaceRoot, 'remote', 'add', 'origin', remote);
  await mkdir(resolve(workspaceRoot, 'pkg'));
  await writeFile(resolve(workspaceRoot, 'README.md'), 'release source\n');
  await writeFile(resolve(workspaceRoot, 'pkg', 'engine.wasm'), 'frozen wasm');
  await git(workspaceRoot, 'add', '.');
  await git(workspaceRoot, 'commit', '-m', 'release source');
  await git(workspaceRoot, 'branch', '-M', 'main');
  await git(workspaceRoot, 'push', '-u', 'origin', 'main');
  await git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const snapshot = await captureWorkspace(workspaceRoot);
  const project = { id: 'engine', workspace: { root: workspaceRoot, excluded: [] }, policy: { release: { gitRemote: 'origin' } } };
  const body = { protocolVersion: '1.0', kind: 'version-release-candidate', status: 'prereleased', projectId: project.id, target: 'V3.8.5',
    sourceDigest: snapshot.digest, artifactRoot: 'pkg', artifacts: [{ path: 'engine.wasm', sha256: sha256('frozen wasm') }] };
  const candidate = { ...body, candidateDigest: digestJson(body) };
  const approval = { id: 'formal-version-release', actor: 'codex-user-command', decision: 'approved', projectId: project.id,
    target: 'V3.8.5', candidateDigest: candidate.candidateDigest };
  const receiptBody = { protocolVersion: '1.0', kind: 'version-release-promotion', projectId: project.id, target: 'V3.8.5',
    candidateDigest: candidate.candidateDigest, toRevision: 2, releasedAt: '2026-10-11T00:00:00.000Z', approval };
  const receipt = { ...receiptBody, receiptDigest: digestJson(receiptBody) };
  return { root, workspaceRoot, project, candidate, receipt };
};

test('formal version release is published as an immutable remote tag and verified on a new machine', async t => {
  const { root, workspaceRoot, project, candidate, receipt } = await fixture(t);
  const first = await publishGitVersionRelease({ workspaceRoot, temporaryRoot: root, project, target: 'V3.8.5', candidate, receipt });
  assert.equal(first.remoteVerified, true);
  assert.equal((await publishGitVersionRelease({ workspaceRoot, temporaryRoot: root, project, target: 'V3.8.5', candidate, receipt })).tagOid, first.tagOid);
  const clone = resolve(root, 'clone');
  await git(root, 'clone', resolve(root, 'remote.git'), clone);
  const verified = await verifyGitVersionRelease({ workspaceRoot: clone, projectId: 'engine', target: 'V3.8.5' });
  assert.equal(verified.record.candidate.candidateDigest, candidate.candidateDigest);
  const recovered = await readPortableVersionRelease({ dataRoot: resolve(root, 'empty-data'),
    project: { ...project, workspace: { root: clone } }, target: 'V3.8.5', workspaceRoot: clone });
  assert.equal(recovered.state.status, 'released');
  assert.equal(recovered.state.source, 'verified-git-release');
  assert.equal(recovered.receipt.receiptDigest, receipt.receiptDigest);
});

test('Git publication rejects a package that was not committed into the release commit', async t => {
  const { root, workspaceRoot, project, candidate, receipt } = await fixture(t);
  const changed = { ...candidate, artifacts: [{ path: 'engine.wasm', sha256: sha256('other wasm') }] };
  changed.candidateDigest = digestJson(Object.fromEntries(Object.entries(changed).filter(([key]) => key !== 'candidateDigest')));
  const changedReceiptBody = { ...receipt, candidateDigest: changed.candidateDigest,
    approval: { ...receipt.approval, candidateDigest: changed.candidateDigest } };
  delete changedReceiptBody.receiptDigest;
  const changedReceipt = { ...changedReceiptBody, receiptDigest: digestJson(changedReceiptBody) };
  await assert.rejects(() => publishGitVersionRelease({ workspaceRoot, temporaryRoot: root, project, target: 'V3.8.5', candidate: changed, receipt: changedReceipt }),
    error => error.code === 'RELEASE_GIT_ARTIFACT_MISMATCH');
  assert.equal(await verifyGitVersionRelease({ workspaceRoot, projectId: 'engine', target: 'V3.8.5' }), null);
});

test('a legacy local-only approval publishes its original receipt without another prerelease', async t => {
  const { root, workspaceRoot, project, candidate, receipt } = await fixture(t);
  const dataRoot = resolve(root, 'data');
  const releaseRoot = resolve(dataRoot, 'version-releases', project.id, 'V3.8.5');
  const manifestRoot = resolve(releaseRoot, 'candidates', candidate.candidateDigest);
  await mkdir(manifestRoot, { recursive: true });
  await writeFile(resolve(manifestRoot, 'candidate.json'), JSON.stringify(candidate));
  await writeFile(resolve(releaseRoot, 'state.json'), JSON.stringify({ revision: 2, status: 'released',
    candidateDigest: candidate.candidateDigest, commands: { 'old-command': receipt } }));
  const result = await publishVersionRelease({ dataRoot, project, target: 'V3.8.5', workspaceRoot, candidateDigest: candidate.candidateDigest });
  assert.equal(result.receipt.receiptDigest, receipt.receiptDigest);
  assert.equal(result.state.revision, 2);
  assert.equal(result.state.publication.remoteVerified, true);
  const repeated = await publishVersionRelease({ dataRoot, project, target: 'V3.8.5', workspaceRoot, candidateDigest: candidate.candidateDigest });
  assert.deepEqual(repeated.state.publication, result.state.publication);
});
