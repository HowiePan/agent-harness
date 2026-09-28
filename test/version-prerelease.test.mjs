import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { harnessTemporaryRoot } from '../src/common/write-boundary.mjs';
import { digestJson, sha256 } from '../src/common/canonical.mjs';
import { captureWorkspace } from '../src/common/workspace-snapshot.mjs';
import { loadReleaseDocumentationScope } from '../src/application/release-documentation-scope.mjs';
import { ensurePreReleaseCandidate, promoteVersionRelease, readDevelopmentClearance, readVersionRelease } from '../src/application/version-prerelease.mjs';
import { createCardWorldProjectDescriptor, createCardWorldLifecyclePlan } from '../integrations/legacy-consumers/cardworld/index.mjs';

const setup = async t => {
  const parent = harnessTemporaryRoot();
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'prerelease-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = resolve(root, 'workspace');
  const dataRoot = resolve(root, 'data');
  await mkdir(resolve(workspaceRoot, 'release'), { recursive: true });
  await mkdir(resolve(workspaceRoot, 'docs', 'old'), { recursive: true });
  await mkdir(resolve(workspaceRoot, 'card_world_engine', 'pkg'), { recursive: true });
  await mkdir(dataRoot, { recursive: true });
  await writeFile(resolve(workspaceRoot, 'README.md'), 'current\n');
  await writeFile(resolve(workspaceRoot, 'docs', 'old', 'history.md'), 'history\n');
  await writeFile(resolve(workspaceRoot, 'release', 'docs-scope.json'), JSON.stringify({ schemaVersion: '1.0', documents: [{ main: 'README.md' }], directories: ['docs/old'] }));
  await writeFile(resolve(workspaceRoot, 'card_world_engine', 'pkg', 'package.json'), JSON.stringify({ version: '3.8.4' }));
  await writeFile(resolve(workspaceRoot, 'card_world_engine', 'pkg', 'engine_bg.wasm'), 'wasm');
  const project = {
    id: 'cardworld-engine', descriptorDigest: 'a'.repeat(64),
    workspace: { root: workspaceRoot, excluded: ['card_world_engine/pkg'] },
    policy: { release: { documentationScopePath: 'release/docs-scope.json', artifactRoot: 'card_world_engine/pkg', packageGateId: 'package', artifactIdentity: { path: 'package.json', versionField: 'version' } } },
  };
  return { workspaceRoot, dataRoot, project };
};

test('project-owned documentation scope expands historical files and rejects traversal', async t => {
  const fixture = await setup(t);
  const docs = await loadReleaseDocumentationScope({ workspaceRoot: fixture.workspaceRoot, configPath: 'release/docs-scope.json', excluded: fixture.project.workspace.excluded });
  assert.deepEqual(docs.files.map(file => file.path), ['docs/old/history.md', 'README.md']);
  assert.deepEqual(docs.allowedPaths, ['README.md', 'docs/old']);
  await writeFile(resolve(fixture.workspaceRoot, 'release', 'docs-scope.json'), JSON.stringify({ schemaVersion: '1.0', documents: [{ main: '../outside.md' }], directories: [] }));
  await assert.rejects(() => loadReleaseDocumentationScope({ workspaceRoot: fixture.workspaceRoot, configPath: 'release/docs-scope.json' }), error => error.code === 'RELEASE_DOCUMENT_PATH_INVALID');
  await writeFile(resolve(fixture.workspaceRoot, 'release', 'docs-scope.json'), JSON.stringify({ schemaVersion: '1.0', documents: [{ main: 'README.md' }], directories: ['card_world_engine/pkg'] }));
  await assert.rejects(() => loadReleaseDocumentationScope({ workspaceRoot: fixture.workspaceRoot, configPath: 'release/docs-scope.json', excluded: fixture.project.workspace.excluded }), error => error.code === 'RELEASE_DOCUMENT_EXCLUDED');
});

test('nested build output exclusion keeps package bytes outside source digest', async t => {
  const fixture = await setup(t);
  const before = await captureWorkspace(fixture.workspaceRoot, { excluded: fixture.project.workspace.excluded });
  await writeFile(resolve(fixture.workspaceRoot, 'card_world_engine', 'pkg', 'engine_bg.wasm'), 'new build');
  const after = await captureWorkspace(fixture.workspaceRoot, { excluded: fixture.project.workspace.excluded });
  assert.equal(after.digest, before.digest);
});

test('development clearance accepts only declared release delta and prerelease bypasses review budget', async t => {
  const fixture = await setup(t);
  const snapshot = await captureWorkspace(fixture.workspaceRoot, { excluded: fixture.project.workspace.excluded });
  const baseline = { ...snapshot, files: snapshot.files.filter(file => file.path !== 'release/docs-scope.json') };
  baseline.digest = digestJson(baseline.files);
  const receiptBody = { kind: 'version-clearance', status: 'development-complete', projectId: fixture.project.id,
    runId: 'quality-1', target: 'V3.8.4', sourceDigest: baseline.digest, runClosureDigest: 'c'.repeat(64) };
  const receipt = { ...receiptBody, receiptDigest: digestJson(receiptBody) };
  const receiptRoot = resolve(fixture.dataRoot, 'receipts', fixture.project.id, 'quality-1');
  await mkdir(receiptRoot, { recursive: true });
  await writeFile(resolve(receiptRoot, `${receipt.receiptDigest}.version-clearance.json`), JSON.stringify(receipt));
  const run = { runId: 'quality-1', status: 'closed', sourceDigest: baseline.digest, closedAt: '2026-09-27T00:00:00Z',
    metadata: { commandIntent: { action: 'quality', target: 'V3.8.4' } }, dispatches: [{ sourceDigest: baseline.digest, sourceSnapshotRef: 'snapshot' }],
    receipts: [{ kind: 'run-closure', digest: 'c'.repeat(64) }], findings: [], decisions: [{ id: 'routine-version-exit', decision: 'approved' }] };
  const source = await readDevelopmentClearance({ dataRoot: fixture.dataRoot, projectId: fixture.project.id, target: 'V3.8.4', runs: [run],
    evidenceStore: { read: async () => ({ bytes: Buffer.from(JSON.stringify(baseline)), metadata: { sourceDigest: baseline.digest } }) }, currentSnapshot: snapshot,
    allowedPaths: ['release/docs-scope.json'] });
  assert.deepEqual(source.authorizedPreReleaseDelta, ['release/docs-scope.json']);
  await assert.rejects(() => readDevelopmentClearance({ dataRoot: fixture.dataRoot, projectId: fixture.project.id, target: 'V3.8.4',
    runs: [{ ...run, decisions: [] }], evidenceStore: { read: async () => ({ bytes: Buffer.from(JSON.stringify(baseline)), metadata: { sourceDigest: baseline.digest } }) },
    currentSnapshot: snapshot, allowedPaths: ['release/docs-scope.json'] }), error => error.code === 'DEVELOPMENT_EXIT_APPROVAL_REQUIRED');
  await writeFile(resolve(fixture.workspaceRoot, 'engine.rs'), 'changed');
  const drift = await captureWorkspace(fixture.workspaceRoot, { excluded: fixture.project.workspace.excluded });
  await assert.rejects(() => readDevelopmentClearance({ dataRoot: fixture.dataRoot, projectId: fixture.project.id, target: 'V3.8.4', runs: [run],
    evidenceStore: { read: async () => ({ bytes: Buffer.from(JSON.stringify(baseline)), metadata: { sourceDigest: baseline.digest } }) }, currentSnapshot: drift,
    allowedPaths: ['release/docs-scope.json'] }), error => error.code === 'PRERELEASE_FUNCTIONAL_SOURCE_DRIFT');

  const descriptor = createCardWorldProjectDescriptor({ workspaceRoot: fixture.workspaceRoot });
  const docs = await loadReleaseDocumentationScope({ workspaceRoot: fixture.workspaceRoot, configPath: 'release/docs-scope.json', excluded: descriptor.workspace.excluded });
  const plan = createCardWorldLifecyclePlan({ intent: { action: 'prerelease', target: 'V3.8.4', qualityTarget: { reviewHistory: Array(100).fill({}) },
    developmentClearance: receipt, releaseDocumentation: docs }, project: descriptor, runId: 'prerelease-1', sourceDigest: drift.digest });
  assert.deepEqual(plan.run.features.map(feature => feature.metadata.stage), ['release-preparation', 'release-documentation']);
  assert(plan.stopCondition.requiredFinalGates.includes('wasm-release-package'));
  assert(plan.run.features.find(feature => feature.metadata.stage === 'release-documentation').allowedPaths.includes('docs/old'));
});

test('candidate seals final docs and package; promotion only changes status for exact approval', async t => {
  const { workspaceRoot, dataRoot, project } = await setup(t);
  const docs = await loadReleaseDocumentationScope({ workspaceRoot, configPath: project.policy.release.documentationScopePath, excluded: project.workspace.excluded });
  const snapshot = await captureWorkspace(workspaceRoot, { excluded: project.workspace.excluded });
  const audit = { auditedFiles: docs.files.map(file => file.path), updatedFiles: ['README.md'], resolved: ['old README corrected'], unresolved: [] };
  const state = {
    status: 'closed', runId: 'prerelease-1', sourceDigest: snapshot.digest,
    metadata: { projectDescriptorDigest: project.descriptorDigest, commandIntent: { action: 'prerelease', target: 'V3.8.4', releaseDocumentation: docs,
      developmentClearance: { status: 'development-complete', receiptDigest: digestJson({ status: 'development-complete' }) } } },
    profile: { config: { requiredFinalGates: ['package'] } },
    features: [{ id: 'release-docs/V3.8.4', submissionId: 'docs-ok', metadata: { stage: 'release-documentation' } }],
    submissions: [
      { submissionId: 'docs-rejected', featureId: 'release-docs/V3.8.4', result: { status: 'failed', changedFiles: [], blocker: { code: 'PROFILE_RESULT_REJECTED' } } },
      { submissionId: 'docs-ok', featureId: 'release-docs/V3.8.4', result: { status: 'completed', changedFiles: ['README.md'], outputs: { 'release-docs': { value: audit } } } },
    ],
    gates: [{ id: 'package', scope: 'final', status: 'passed', forcedFresh: true, sourceDigest: snapshot.digest, evidenceRefs: ['gate-evidence'] }],
    receipts: [{ kind: 'run-closure', digest: 'c'.repeat(64) }],
  };
  const incomplete = structuredClone(state);
  incomplete.submissions[1].result.outputs['release-docs'].value.updatedFiles = [];
  await assert.rejects(() => ensurePreReleaseCandidate({ dataRoot, project, state: incomplete, workspaceRoot }),
    error => error.code === 'PRERELEASE_DOCUMENT_AUDIT_INCOMPLETE');
  const first = await ensurePreReleaseCandidate({ dataRoot, project, state, workspaceRoot });
  const second = await ensurePreReleaseCandidate({ dataRoot, project, state, workspaceRoot });
  assert.equal(first.candidate.candidateDigest, second.candidate.candidateDigest);
  assert.equal(second.state.revision, 1);
  assert.equal((await readVersionRelease({ dataRoot, projectId: project.id, target: 'V3.8.4' })).state.status, 'prereleased');
  const request = { dataRoot, project, target: 'V3.8.4', workspaceRoot, candidateDigest: first.candidate.candidateDigest,
    expectedRevision: 1, commandId: 'approve-1', approval: { id: 'formal-version-release', actor: 'user', decision: 'approved', projectId: project.id, target: 'V3.8.4', candidateDigest: first.candidate.candidateDigest } };
  await assert.rejects(() => promoteVersionRelease({ ...request, approval: { ...request.approval, candidateDigest: 'd'.repeat(64) } }), error => error.code === 'RELEASE_PROMOTION_DECISION_REQUIRED');
  await writeFile(resolve(workspaceRoot, 'README.md'), 'drift');
  await assert.rejects(() => promoteVersionRelease(request), error => error.code === 'RELEASE_PROMOTION_SOURCE_DRIFT');
  await writeFile(resolve(workspaceRoot, 'README.md'), 'current\n');
  const beforeArtifact = await readFile(resolve(workspaceRoot, 'card_world_engine', 'pkg', 'engine_bg.wasm'));
  const promoted = await promoteVersionRelease(request);
  assert.equal(promoted.state.status, 'released');
  assert.equal(promoted.state.revision, 2);
  assert.deepEqual(await readFile(resolve(workspaceRoot, 'card_world_engine', 'pkg', 'engine_bg.wasm')), beforeArtifact);
  assert.equal((await promoteVersionRelease(request)).receipt.receiptDigest, promoted.receipt.receiptDigest);
});
