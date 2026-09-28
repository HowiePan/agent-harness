import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digestJson } from '../src/common/canonical.mjs';
import { captureWorkspace } from '../src/common/workspace-snapshot.mjs';
import { harnessTemporaryRoot } from '../src/common/write-boundary.mjs';
import { readBatchClearance, ensureBatchPreReleaseCandidate, readBatchRelease, promoteBatchRelease } from '../src/application/batch-prerelease.mjs';
import { collectionWorkflowDefinition, createTabletopCollectionLifecyclePlan } from '../integrations/legacy-consumers/collection/index.mjs';

test('Collection prerelease freezes the exact approved items and promotion is state-only and idempotent', async t => {
  const parent = resolve(harnessTemporaryRoot(), 'batch-prerelease');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'case-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = resolve(root, 'Collection');
  const dataRoot = resolve(root, 'data');
  await mkdir(resolve(workspaceRoot, '.git'), { recursive: true });
  await mkdir(resolve(workspaceRoot, 'dist'), { recursive: true });
  await writeFile(resolve(workspaceRoot, 'README.md'), 'approved source\n');
  await writeFile(resolve(workspaceRoot, 'dist', 'manifest.json'), JSON.stringify({ batchId: 'B1', gameIds: ['g1', 'g2'] }));
  await writeFile(resolve(workspaceRoot, 'dist', 'pack.bin'), 'pack bytes');
  const project = { id: 'tabletop-collection', descriptorDigest: 'd'.repeat(64), workspace: { root: workspaceRoot, excluded: ['.git', 'dist'] },
    policy: { collectionBatches: [{ id: 'B1', gameIds: ['g1', 'g2'], ruleStatus: 'rule-ready' }], release: { artifactRoot: 'dist', manifestPath: 'manifest.json', manifestItemsKey: 'gameIds', packageGateId: 'package' } },
    gateRecipes: [{ id: 'package', scope: 'final', required: true }] };
  const sourceDigest = (await captureWorkspace(workspaceRoot, { excluded: project.workspace.excluded })).digest;
  const closureBody = { projectId: project.id, runId: 'full-b1', sourceDigest };
  const closure = { ...closureBody, receiptDigest: digestJson(closureBody) };
  const closureFile = resolve(dataRoot, 'receipts', 'full-b1.json');
  await mkdir(resolve(dataRoot, 'receipts'), { recursive: true });
  await writeFile(closureFile, JSON.stringify(closure));
  const fullRun = { projectId: project.id, runId: 'full-b1', status: 'closed', sourceDigest, findings: [], closedAt: '2026-09-28T00:00:00.000Z',
    metadata: { projectDescriptorDigest: project.descriptorDigest,
      workflow: { id: collectionWorkflowDefinition.id, artifactDigest: collectionWorkflowDefinition.artifactDigest },
      commandIntent: { action: 'full', target: 'B1' } },
    decisions: [{ id: 'game:g1:accepted', decision: 'approved' }, { id: 'game:g2:accepted', decision: 'approved' }, { id: 'batch:B1:closed', decision: 'approved' }],
    receipts: [{ kind: 'run-closure', file: closureFile, digest: closure.receiptDigest }] };
  const clearance = await readBatchClearance({ dataRoot, project, workflowId: collectionWorkflowDefinition.id,
    target: 'B1', runs: [fullRun], sourceDigest });
  const plan = createTabletopCollectionLifecyclePlan({ intent: { action: 'prerelease', target: 'B1', scope: 'batch-release-preparation', batchClearance: clearance },
    project, runId: 'prerelease-b1', sourceDigest });
  assert.deepEqual(plan.run.features.map(feature => feature.metadata.gameId), ['g1', 'g2']);
  assert.deepEqual(plan.stopCondition.requiredFinalGates, ['package']);
  const prereleaseState = { status: 'closed', runId: 'prerelease-b1', sourceDigest,
    metadata: { projectDescriptorDigest: project.descriptorDigest,
      workflow: { id: collectionWorkflowDefinition.id, artifactDigest: collectionWorkflowDefinition.artifactDigest },
      commandIntent: { action: 'prerelease', target: 'B1', batchClearance: clearance } },
    profile: { config: { requiredFinalGates: ['package'] } },
    gates: [{ id: 'package', scope: 'final', status: 'passed', forcedFresh: true, sourceDigest, evidenceRefs: ['gate:package'] }],
    receipts: [{ kind: 'run-closure', digest: 'c'.repeat(64) }] };
  const frozen = await ensureBatchPreReleaseCandidate({ dataRoot, project, state: prereleaseState, workspaceRoot });
  assert.equal(frozen.state.status, 'prereleased');
  assert.deepEqual(frozen.candidate.itemIds, ['g1', 'g2']);
  assert.equal((await readBatchRelease({ dataRoot, projectId: project.id, target: 'B1' })).candidate.candidateDigest, frozen.candidate.candidateDigest);
  const approval = { id: 'formal-batch-release', actor: 'test-user', decision: 'approved', projectId: project.id, target: 'B1', candidateDigest: frozen.candidate.candidateDigest };
  const promoted = await promoteBatchRelease({ dataRoot, project, target: 'B1', workspaceRoot,
    candidateDigest: frozen.candidate.candidateDigest, expectedRevision: frozen.state.revision, commandId: 'release-b1', approval });
  assert.equal(promoted.state.status, 'released');
  const repeated = await promoteBatchRelease({ dataRoot, project, target: 'B1', workspaceRoot,
    candidateDigest: frozen.candidate.candidateDigest, expectedRevision: frozen.state.revision, commandId: 'release-b1', approval });
  assert.deepEqual(repeated.receipt, promoted.receipt);
});
