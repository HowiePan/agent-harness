import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assert } from '../common/errors.mjs';
import { digestJson, withoutKeys } from '../common/canonical.mjs';
import { assertInside, assertNoLinkPath, safeSegment, slash } from '../common/paths.mjs';
import { captureWorkspace, diffWorkspaceSnapshots } from '../common/workspace-snapshot.mjs';
import { currentFeatureSubmission } from '../common/feature-submission.mjs';
import { loadReleaseDocumentationScope } from './release-documentation-scope.mjs';
import { freezeReleaseCandidate, promoteReleaseCandidate, readReleaseCandidate } from '../platform/release/candidate-store.mjs';
import { inventoryReleaseArtifacts, safeReleaseRelativePath } from '../platform/release/artifacts.mjs';

const digestPattern = /^[a-f0-9]{64}$/;

export const readDevelopmentClearance = async ({ dataRoot, projectId, target, runs, evidenceStore, currentSnapshot, allowedPaths, excluded = [] }) => {
  const closed = runs.filter(run => run.status === 'closed' && run.metadata?.commandIntent?.target === target
    && ['implement', 'quality', 'full', 'deliver'].includes(run.metadata?.commandIntent?.action)
    && (run.metadata.commandIntent.action !== 'implement' || (run.profile?.config?.requireFinalQualityReview === true && run.features?.some(feature => feature.metadata?.qualityReview === true)))).sort((a, b) => String(b.closedAt).localeCompare(String(a.closedAt)));
  for (const run of closed) {
    const directory = resolve(dataRoot, 'receipts', safeSegment(projectId), safeSegment(run.runId));
    let names;
    try { names = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const name of names.filter(item => item.endsWith('.version-clearance.json'))) {
      const file = assertInside(dataRoot, resolve(directory, name), 'development clearance');
      const receipt = JSON.parse(await readFile(file, 'utf8'));
      if (receipt.kind !== 'version-clearance' || receipt.status !== 'development-complete' || receipt.projectId !== projectId
        || receipt.target !== target || receipt.runId !== run.runId || receipt.sourceDigest !== run.sourceDigest) continue;
      assert(receipt.receiptDigest === digestJson(withoutKeys(receipt, ['receiptDigest'])), 'DEVELOPMENT_CLEARANCE_DIGEST_MISMATCH', 'Development clearance digest is invalid.');
      const closureRef = run.receipts?.find(item => item.kind === 'run-closure');
      assert(closureRef?.digest === receipt.runClosureDigest && !(run.findings ?? []).some(item => item.status !== 'resolved'),
        'DEVELOPMENT_CLEARANCE_AUTHORITY_MISMATCH', 'Development clearance does not match a clean authoritative Run closure.');
      assert(run.decisions?.some(item => item.id === 'routine-version-exit' && item.decision === 'approved'),
        'DEVELOPMENT_EXIT_APPROVAL_REQUIRED', 'Prerelease requires an approved development exit Decision.');
      const snapshotRef = [...run.dispatches].reverse().find(dispatch => dispatch.sourceDigest === run.sourceDigest && dispatch.sourceSnapshotRef)?.sourceSnapshotRef;
      assert(snapshotRef, 'DEVELOPMENT_SOURCE_SNAPSHOT_REQUIRED', 'Development clearance requires an exact source inventory for release delta checks.');
      const evidence = await evidenceStore.read(snapshotRef);
      assert(evidence.metadata?.sourceDigest === receipt.sourceDigest, 'DEVELOPMENT_SOURCE_EVIDENCE_MISMATCH', 'Development source evidence does not bind the clearance digest.');
      const baseline = JSON.parse(evidence.bytes.toString('utf8'));
      assert(baseline.digest === receipt.sourceDigest, 'DEVELOPMENT_SOURCE_SNAPSHOT_MISMATCH', 'Development source inventory differs from clearance.');
      // Older workspace snapshots did not honor nested exclusions. Preserve their
      // original digest for clearance verification, then compare the same scope.
      const excludedPaths = excluded.map(path => slash(path).replace(/\/$/, '')).filter(path => path.includes('/'));
      const scopedBaseline = { ...baseline, files: baseline.files.filter(file => !excludedPaths.some(path => file.path === path || file.path.startsWith(`${path}/`))) };
      const changed = diffWorkspaceSnapshots(scopedBaseline, currentSnapshot);
      const allowed = path => allowedPaths.some(root => path === root || path.startsWith(`${root}/`));
      assert(changed.every(allowed), 'PRERELEASE_FUNCTIONAL_SOURCE_DRIFT', 'Source changed outside release metadata and project-declared documentation after development clearance.', { changed: changed.filter(path => !allowed(path)) });
      return { receipt, baselineFiles: baseline.files, authorizedPreReleaseDelta: changed };
    }
  }
  assert(false, 'DEVELOPMENT_CLEARANCE_REQUIRED', `No approved development clearance was found for ${target}.`);
};

export const ensurePreReleaseCandidate = async ({ dataRoot, project, state, workspaceRoot }) => {
  if (state.status !== 'closed' || state.metadata?.commandIntent?.action !== 'prerelease') return null;
  const intent = state.metadata.commandIntent;
  assert(intent.developmentClearance?.status === 'development-complete'
    && intent.developmentClearance.receiptDigest === digestJson(withoutKeys(intent.developmentClearance, ['receiptDigest'])),
  'PRERELEASE_CLEARANCE_INVALID', 'Prerelease does not bind a valid development clearance.');
  const release = project.policy?.release;
  assert(release?.documentationScopePath && release?.artifactRoot && release?.packageGateId, 'PRERELEASE_POLICY_REQUIRED', 'Project release policy is incomplete.');
  assert(state.metadata.projectDescriptorDigest === project.descriptorDigest, 'PRERELEASE_PROJECT_DRIFT', 'Project release policy changed during prerelease.');
  const snapshot = await captureWorkspace(workspaceRoot, { excluded: project.workspace.excluded ?? [] });
  assert(snapshot.digest === state.sourceDigest, 'PRERELEASE_SOURCE_DRIFT', 'Source changed after prerelease Gates.');
  const docs = await loadReleaseDocumentationScope({ workspaceRoot, configPath: release.documentationScopePath, excluded: project.workspace.excluded ?? [] });
  assert(docs.configSha256 === intent.releaseDocumentation.configSha256, 'PRERELEASE_DOCUMENT_SCOPE_DRIFT', 'Project documentation scope changed during prerelease.');
  const docsFeature = state.features.find(feature => feature.metadata?.stage === 'release-documentation');
  const result = currentFeatureSubmission(state, docsFeature, { status: 'completed' })?.result;
  const audit = result?.outputs?.['release-docs']?.value;
  const finalFiles = docs.files.map(file => file.path);
  assert(audit && Array.isArray(audit.auditedFiles) && digestJson([...audit.auditedFiles].sort()) === digestJson([...finalFiles].sort())
    && Array.isArray(audit.updatedFiles) && digestJson([...audit.updatedFiles].sort()) === digestJson([...(result.changedFiles ?? [])].sort())
    && audit.updatedFiles.every(file => finalFiles.includes(file))
    && Array.isArray(audit.unresolved) && audit.unresolved.length === 0,
  'PRERELEASE_DOCUMENT_AUDIT_INCOMPLETE', 'Documentation audit must cover every configured file with no unresolved issue.');
  const required = state.profile.config.requiredFinalGates ?? [];
  assert(required.includes(release.packageGateId) && required.every(id => state.gates.some(gate => gate.id === id && gate.scope === 'final' && gate.status === 'passed' && gate.forcedFresh && gate.sourceDigest === state.sourceDigest)), 'PRERELEASE_FINAL_GATES_REQUIRED', 'Prerelease requires fresh final Gates including the real package build.');
  const artifacts = await inventoryReleaseArtifacts(workspaceRoot, release.artifactRoot);
  const identity = release.artifactIdentity;
  assert(identity?.path && identity.versionField && artifacts.files.some(file => file.path === identity.path), 'PRERELEASE_PACKAGE_IDENTITY_REQUIRED', 'Release package identity file is missing.');
  safeReleaseRelativePath(identity.path, 'release artifact identity');
  const packageIdentity = JSON.parse(await readFile(assertNoLinkPath(artifacts.absoluteRoot, resolve(artifacts.absoluteRoot, identity.path), 'release artifact identity'), 'utf8'));
  assert(packageIdentity[identity.versionField] === intent.target.replace(/^v/i, ''), 'PRERELEASE_PACKAGE_VERSION_MISMATCH', 'Release package version differs from the target.');
  const closure = state.receipts.find(item => item.kind === 'run-closure');
  assert(closure?.digest, 'PRERELEASE_RUN_CLOSURE_REQUIRED', 'Prerelease requires a sealed Run closure.');
  const body = {
    protocolVersion: '1.0', kind: 'version-release-candidate', projectId: project.id, target: intent.target,
    status: 'prereleased', sourceDigest: state.sourceDigest, descriptorDigest: project.descriptorDigest,
    developmentClearanceDigest: intent.developmentClearance.receiptDigest, prereleaseRunId: state.runId,
    runClosureDigest: closure.digest, documentation: { configSha256: docs.configSha256, inventoryDigest: docs.inventoryDigest, files: docs.files, audit },
    artifactRoot: release.artifactRoot, artifacts: artifacts.files,
    finalGates: required.map(id => { const gate = [...state.gates].reverse().find(item => item.id === id && item.scope === 'final'); return { id, evidenceRefs: gate.evidenceRefs }; }),
  };
  const candidate = { ...body, candidateDigest: digestJson(body) };
  return freezeReleaseCandidate({ dataRoot, namespace: 'version-releases', projectId: project.id, target: intent.target,
    candidate, artifactRoot: artifacts.absoluteRoot });
};

export const readVersionRelease = async ({ dataRoot, projectId, target }) => readReleaseCandidate({ dataRoot, namespace: 'version-releases', projectId, target });

export const promoteVersionRelease = async ({ dataRoot, project, target, workspaceRoot, candidateDigest, expectedRevision, commandId, approval }) => {
  assert(digestPattern.test(candidateDigest ?? '') && commandId && Number.isInteger(expectedRevision), 'RELEASE_PROMOTION_INPUT_INVALID', 'Promotion requires a candidate digest, command ID, and expected revision.');
  assert(approval?.id === 'formal-version-release' && approval.actor && approval.actor !== 'project-local-invocation'
    && approval.decision === 'approved' && approval.projectId === project.id && approval.target === target && approval.candidateDigest === candidateDigest,
    'RELEASE_PROMOTION_DECISION_REQUIRED', 'Formal release approval must bind the exact candidate.');
  return promoteReleaseCandidate({ dataRoot, namespace: 'version-releases', project, target, workspaceRoot,
    candidateDigest, expectedRevision, commandId, approval, promotionKind: 'version-release-promotion' });
};
