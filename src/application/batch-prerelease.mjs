import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assert } from '../common/errors.mjs';
import { digestJson, sha256, withoutKeys } from '../common/canonical.mjs';
import { assertInside, assertNoLinkPath } from '../common/paths.mjs';
import { captureWorkspace } from '../common/workspace-snapshot.mjs';
import { inventoryReleaseArtifacts, safeReleaseRelativePath } from '../platform/release/artifacts.mjs';
import { freezeReleaseCandidate, promoteReleaseCandidate, readReleaseCandidate } from '../platform/release/candidate-store.mjs';

const batchItems = (project, target) => {
  const batch = (project.policy?.collectionBatches ?? project.policy?.batches ?? []).find(item => item.id === target);
  const itemIds = batch?.gameIds ?? batch?.itemIds ?? batch?.items;
  assert(Array.isArray(itemIds) && itemIds.length > 0 && new Set(itemIds).size === itemIds.length, 'BATCH_RELEASE_ITEMS_REQUIRED', 'Release requires a declared non-empty batch.');
  return itemIds;
};

export const readBatchClearance = async ({ dataRoot, project, workflowId, target, runs, sourceDigest }) => {
  const itemIds = batchItems(project, target);
  const closed = runs.filter(run => run.status === 'closed' && run.metadata?.commandIntent?.action === 'full'
    && run.metadata.commandIntent.target === target && run.metadata?.projectDescriptorDigest === project.descriptorDigest
    && run.metadata?.workflow?.id === workflowId)
    .sort((a, b) => String(b.closedAt).localeCompare(String(a.closedAt)));
  for (const run of closed) {
    if (run.sourceDigest !== sourceDigest || run.findings?.some(finding => finding.status !== 'resolved')) continue;
    if (!run.decisions?.some(item => item.id === `batch:${target}:closed` && item.decision === 'approved')) continue;
    if (!itemIds.every(id => run.decisions.some(item => (item.id === `item:${id}:accepted` || item.id === `game:${id}:accepted`) && item.decision === 'approved'))) continue;
    const closureRef = run.receipts?.find(item => item.kind === 'run-closure');
    if (!closureRef?.file || !closureRef.digest) continue;
    const closureFile = assertInside(dataRoot, closureRef.file, 'batch closure receipt');
    const closure = JSON.parse(await readFile(closureFile, 'utf8'));
    assert(closure.receiptDigest === closureRef.digest && digestJson(withoutKeys(closure, ['receiptDigest'])) === closureRef.digest
      && closure.projectId === project.id && closure.runId === run.runId && closure.sourceDigest === sourceDigest,
    'BATCH_CLEARANCE_RECEIPT_MISMATCH', 'Batch closure receipt does not match authoritative Run state.');
    const body = { version: '1.0', kind: 'batch-clearance', projectId: project.id, workflowId,
      workflowDigest: run.metadata.workflow.artifactDigest, target, runId: run.runId,
      sourceDigest, descriptorDigest: project.descriptorDigest, runClosureDigest: closureRef.digest, itemIds: [...itemIds] };
    return { ...body, receiptDigest: digestJson(body) };
  }
  assert(false, 'BATCH_CLEARANCE_REQUIRED', 'Prerelease requires a closed full batch Run with current source, every item accepted, and batch close approval.');
};

export const ensureBatchPreReleaseCandidate = async ({ dataRoot, project, state, workspaceRoot }) => {
  if (state.status !== 'closed' || state.metadata?.commandIntent?.action !== 'prerelease') return null;
  const intent = state.metadata.commandIntent;
  const clearance = intent.batchClearance;
  assert(clearance?.kind === 'batch-clearance' && clearance.receiptDigest === digestJson(withoutKeys(clearance, ['receiptDigest']))
    && clearance.projectId === project.id && clearance.target === intent.target && clearance.sourceDigest === state.sourceDigest
    && clearance.workflowId === state.metadata?.workflow?.id && clearance.workflowDigest === state.metadata.workflow.artifactDigest,
  'BATCH_PRERELEASE_CLEARANCE_INVALID', 'Prerelease does not bind current authoritative batch clearance.');
  const release = project.policy?.release;
  assert(release?.artifactRoot && release?.packageGateId && release?.manifestPath, 'BATCH_PRERELEASE_POLICY_REQUIRED', 'Batch release policy requires an artifact root, package Gate, and manifest path.');
  assert(project.descriptorDigest === state.metadata.projectDescriptorDigest, 'BATCH_PRERELEASE_PROJECT_DRIFT', 'Project release policy changed during prerelease.');
  const snapshot = await captureWorkspace(workspaceRoot, { excluded: project.workspace.excluded ?? [] });
  assert(snapshot.digest === state.sourceDigest, 'BATCH_PRERELEASE_SOURCE_DRIFT', 'Source changed after batch prerelease Gates.');
  const required = state.profile.config.requiredFinalGates ?? [];
  assert(required.includes(release.packageGateId) && required.every(id => state.gates.some(gate => gate.id === id && gate.scope === 'final'
    && gate.status === 'passed' && gate.forcedFresh && gate.sourceDigest === state.sourceDigest)),
  'BATCH_PRERELEASE_FINAL_GATES_REQUIRED', 'Batch prerelease requires fresh final Gates including the package Gate.');
  const artifacts = await inventoryReleaseArtifacts(workspaceRoot, release.artifactRoot);
  safeReleaseRelativePath(release.manifestPath, 'batch release manifest');
  const manifestFile = assertNoLinkPath(artifacts.absoluteRoot, resolve(artifacts.absoluteRoot, release.manifestPath), 'batch release manifest');
  const manifestBytes = await readFile(manifestFile);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const itemKey = release.manifestItemsKey ?? 'itemIds';
  assert(manifest.batchId === intent.target && Array.isArray(manifest[itemKey]) && new Set(manifest[itemKey]).size === manifest[itemKey].length
    && digestJson([...manifest[itemKey]].sort()) === digestJson([...clearance.itemIds].sort()),
  'BATCH_RELEASE_MANIFEST_MISMATCH', 'Release manifest must declare the exact approved batch and items.');
  const closure = state.receipts.find(item => item.kind === 'run-closure');
  assert(closure?.digest, 'BATCH_PRERELEASE_RUN_CLOSURE_REQUIRED', 'Prerelease requires a sealed Run closure.');
  const body = { protocolVersion: '1.0', kind: 'batch-release-candidate', projectId: project.id,
    workflowId: clearance.workflowId, workflowDigest: clearance.workflowDigest, target: intent.target,
    status: 'prereleased', sourceDigest: state.sourceDigest, descriptorDigest: project.descriptorDigest,
    batchClearanceDigest: clearance.receiptDigest, prereleaseRunId: state.runId, runClosureDigest: closure.digest,
    itemIds: [...clearance.itemIds], artifactRoot: release.artifactRoot, manifestPath: release.manifestPath,
    manifestSha256: sha256(manifestBytes), artifacts: artifacts.files,
    finalGates: required.map(id => { const gate = [...state.gates].reverse().find(item => item.id === id && item.scope === 'final'); return { id, evidenceRefs: gate.evidenceRefs }; }) };
  const candidate = { ...body, candidateDigest: digestJson(body) };
  return freezeReleaseCandidate({ dataRoot, namespace: 'batch-releases', projectId: project.id, target: intent.target,
    candidate, artifactRoot: artifacts.absoluteRoot });
};

export const readBatchRelease = async ({ dataRoot, projectId, target }) => readReleaseCandidate({ dataRoot, namespace: 'batch-releases', projectId, target });

export const promoteBatchRelease = async ({ dataRoot, project, target, workspaceRoot, candidateDigest, expectedRevision, commandId, approval }) => {
  assert(approval?.id === 'formal-batch-release' && approval.actor && approval.actor !== 'project-local-invocation'
    && approval.decision === 'approved' && approval.projectId === project.id && approval.target === target && approval.candidateDigest === candidateDigest,
  'BATCH_RELEASE_PROMOTION_DECISION_REQUIRED', 'Batch release approval must bind the exact frozen candidate.');
  return promoteReleaseCandidate({ dataRoot, namespace: 'batch-releases', project, target, workspaceRoot,
    candidateDigest, expectedRevision, commandId, approval, promotionKind: 'batch-release-promotion' });
};
