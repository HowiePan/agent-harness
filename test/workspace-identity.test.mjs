import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHarness, createInMemoryRuntime, harnessTemporaryRoot, ProjectGateRunner, resolveProjectWorkspace } from '../src/index.mjs';

let sequence = 0;
const command = state => ({ commandId: `workspace-command-${++sequence}`, ...(state ? { expectedRevision: state.revision } : {}) });

const createRepositoryFixture = async root => {
  const repositoryRoot = resolve(root, 'repository');
  const commonDirectory = resolve(repositoryRoot, '.git');
  const gitDirectory = resolve(commonDirectory, 'worktrees', 'task');
  const worktreeRoot = resolve(root, 'worktree');
  await Promise.all([mkdir(gitDirectory, { recursive: true }), mkdir(worktreeRoot, { recursive: true })]);
  await Promise.all([
    writeFile(resolve(gitDirectory, 'commondir'), '../..\n', 'utf8'),
    writeFile(resolve(worktreeRoot, '.git'), `gitdir: ${gitDirectory}\n`, 'utf8'),
    writeFile(resolve(repositoryRoot, 'base.txt'), 'base\n', 'utf8'),
    writeFile(resolve(worktreeRoot, 'worktree.txt'), 'worktree\n', 'utf8'),
  ]);
  return { repositoryRoot, commonDirectory, worktreeRoot };
};

test('a Run pins a verified linked worktree through Authority and Dispatch', async t => {
  const parent = resolve(harnessTemporaryRoot(), 'workspace-identity-tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'case-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rmdir(parent).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
    await rmdir(harnessTemporaryRoot()).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
  });
  const repository = await createRepositoryFixture(root);
  const harness = await createHarness({ dataRoot: resolve(root, 'data'), strictProjectIdentity: false, releaseIdentity: { version: '1.0.0', artifactDigest: null } });
  const runtimeManifest = { id: 'workspace-test-runtime', kind: 'agent-runtime', version: '1.0.0', capabilities: ['spawn', 'wait', 'send', 'heartbeat', 'interrupt', 'headless'], permissions: [] };
  harness.registerPlugin(runtimeManifest, createInMemoryRuntime({ manifest: runtimeManifest, handler: async () => ({ status: 'completed', summary: 'done', changedFiles: [] }) }));
  await harness.projectRegistry.register({ id: 'project', workspace: { root: repository.repositoryRoot, rootSelector: 'git-worktree', excluded: ['.git'] }, profiles: ['feature-delivery'], policy: { agentExecutionMode: 'headless', runtimePlugins: [runtimeManifest.id], defaultRuntimePlugin: runtimeManifest.id }, gateRecipes: [{ id: 'worktree-gate', scope: 'final', command: [process.execPath, resolve('test', 'fixtures', 'gate-probe.mjs')] }], artifactProviders: [] }, { commandId: 'register-project' });
  const started = await harness.startRun({ projectId: 'project', runId: 'run', profileId: 'feature-delivery', executionWorkspaceRoot: repository.worktreeRoot, features: [{ id: 'one', acceptance: ['done'], dependsOn: [], allowedPaths: ['worktree.txt'], metadata: {} }] }, command());
  assert.equal(started.state.metadata.workspace.root, repository.worktreeRoot);
  assert.equal(started.state.metadata.workspace.selector, 'git-worktree');
  assert.equal(started.state.metadata.workspace.identity.commonDir, repository.commonDirectory);
  const scheduled = await harness.dispatch('project', 'run', { maxConcurrency: 1 }, command(started.state));
  assert.equal(scheduled.result.dispatches[0].packet.workspace.root, repository.worktreeRoot);
  const gates = await new ProjectGateRunner({ harness, onProgress: () => {} }).run({ projectId: 'project', runId: 'run', scope: 'final' });
  assert.equal(gates.results[0].status, 'passed');
});

test('git-worktree selection rejects a different repository', async t => {
  const parent = resolve(harnessTemporaryRoot(), 'workspace-identity-tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'mismatch-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rmdir(parent).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
    await rmdir(harnessTemporaryRoot()).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
  });
  const first = await createRepositoryFixture(resolve(root, 'first'));
  const second = await createRepositoryFixture(resolve(root, 'second'));
  await assert.rejects(
    () => resolveProjectWorkspace({ workspace: { root: first.repositoryRoot, rootSelector: 'git-worktree' } }, second.worktreeRoot),
    error => error.code === 'PROJECT_EXECUTION_WORKSPACE_MISMATCH',
  );
});
