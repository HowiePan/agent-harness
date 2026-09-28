import { mkdir, readFile, readdir, lstat } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { assert } from '../common/errors.mjs';
import { digestJson, sha256, withoutKeys } from '../common/canonical.mjs';
import { assertInside, assertNoLinkPath, safeSegment, slash } from '../common/paths.mjs';
import { captureWorkspace, diffWorkspaceSnapshots } from '../common/workspace-snapshot.mjs';
import { currentFeatureSubmission } from '../common/feature-submission.mjs';
import { atomicWrite, atomicWriteJson, readJson, withDirectoryLock } from '../kernel/atomic-io.mjs';
import { loadReleaseDocumentationScope } from './release-documentation-scope.mjs';

const releaseRoot = (dataRoot, projectId, target) => resolve(dataRoot, 'version-releases', safeSegment(projectId), safeSegment(target));
const statePath = root => resolve(root, 'state.json');
const receiptPath = (root, digest) => resolve(root, 'candidates', safeSegment(digest), 'candidate.json');
const digestPattern = /^[a-f0-9]{64}$/;
const safeRelativePath = (value, label) => {
  assert(typeof value === 'string' && value.length > 0 && value === slash(value) && !value.startsWith('/') && !value.endsWith('/')
    && !value.includes(':') && !value.split('/').some(segment => !segment || segment === '.' || segment === '..'),
  'RELEASE_PATH_INVALID', `${label} must be a safe project-relative path.`);
  return value;
};

export const readDevelopmentClearance = async ({ dataRoot, projectId, target, runs, evidenceStore, currentSnapshot, allowedPaths, excluded = [] }) => {
  const closed = runs.filter(run => run.status === 'closed' && run.metadata?.commandIntent?.target === target
    && ['quality', 'full', 'deliver'].includes(run.metadata?.commandIntent?.action)).sort((a, b) => String(b.closedAt).localeCompare(String(a.closedAt)));
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

const inventoryArtifacts = async (root, relativeRoot) => {
  safeRelativePath(relativeRoot, 'release artifact root');
  const absoluteRoot = assertNoLinkPath(root, resolve(root, relativeRoot), 'release artifact root');
  assert((await lstat(absoluteRoot)).isDirectory(), 'RELEASE_ARTIFACT_ROOT_INVALID', 'Release artifact root must be a directory.');
  const files = [];
  const visit = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = resolve(directory, entry.name);
      const info = await lstat(file);
      assert(!info.isSymbolicLink(), 'RELEASE_ARTIFACT_LINK_FORBIDDEN', `Release artifact contains a link: ${file}`);
      if (info.isDirectory()) await visit(file);
      else if (info.isFile()) {
        const bytes = await readFile(file);
        files.push({ path: slash(relative(absoluteRoot, file)), sha256: sha256(bytes), size: bytes.length });
      } else assert(false, 'RELEASE_ARTIFACT_FILE_INVALID', `Unsupported release artifact entry: ${file}`);
    }
  };
  await visit(absoluteRoot);
  files.sort((a, b) => a.path.localeCompare(b.path));
  assert(files.length > 0, 'RELEASE_ARTIFACT_EMPTY', 'Release artifact package is empty.');
  return { absoluteRoot, files };
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
  const artifacts = await inventoryArtifacts(workspaceRoot, release.artifactRoot);
  const identity = release.artifactIdentity;
  assert(identity?.path && identity.versionField && artifacts.files.some(file => file.path === identity.path), 'PRERELEASE_PACKAGE_IDENTITY_REQUIRED', 'Release package identity file is missing.');
  safeRelativePath(identity.path, 'release artifact identity');
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
  const root = releaseRoot(dataRoot, project.id, intent.target);
  await mkdir(root, { recursive: true });
  return withDirectoryLock(resolve(root, '.lock'), async () => {
    const previous = await readJson(statePath(root), { revision: 0, status: 'none', candidates: [], commands: {} });
    assert(previous.status !== 'released' || previous.candidateDigest === candidate.candidateDigest, 'RELEASE_ALREADY_FINAL', 'A different candidate cannot replace a released version.');
    const destination = resolve(root, 'candidates', candidate.candidateDigest);
    await mkdir(destination, { recursive: true });
    for (const artifact of artifacts.files) {
      const source = assertNoLinkPath(artifacts.absoluteRoot, resolve(artifacts.absoluteRoot, artifact.path), 'release package file');
      const target = assertNoLinkPath(root, resolve(destination, 'artifacts', artifact.path), 'staged release artifact');
      let existing = null;
      try { existing = await readFile(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (existing) assert(sha256(existing) === artifact.sha256, 'RELEASE_STAGED_ARTIFACT_DRIFT', `Staged artifact changed: ${artifact.path}`);
      else {
        const bytes = await readFile(source);
        assert(sha256(bytes) === artifact.sha256, 'RELEASE_ARTIFACT_CHANGED_DURING_STAGE', `Release artifact changed while staging: ${artifact.path}`);
        await atomicWrite(target, bytes, { root });
      }
    }
    const manifestFile = receiptPath(root, candidate.candidateDigest);
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

export const readVersionRelease = async ({ dataRoot, projectId, target }) => {
  const root = releaseRoot(dataRoot, projectId, target);
  const state = await readJson(statePath(root), { revision: 0, status: 'none', candidates: [], commands: {} });
  if (!state.candidateDigest) return { state, candidate: null };
  const candidate = await readJson(receiptPath(root, state.candidateDigest));
  assert(candidate.candidateDigest === digestJson(withoutKeys(candidate, ['candidateDigest'])), 'RELEASE_CANDIDATE_DIGEST_MISMATCH', 'Release candidate digest is invalid.');
  assert(candidate.projectId === projectId && candidate.target === target, 'RELEASE_CANDIDATE_SCOPE_MISMATCH', 'Release candidate belongs to another Project or target.');
  return { state, candidate };
};

export const promoteVersionRelease = async ({ dataRoot, project, target, workspaceRoot, candidateDigest, expectedRevision, commandId, approval }) => {
  assert(digestPattern.test(candidateDigest ?? '') && commandId && Number.isInteger(expectedRevision), 'RELEASE_PROMOTION_INPUT_INVALID', 'Promotion requires a candidate digest, command ID, and expected revision.');
  assert(approval?.id === 'formal-version-release' && approval.actor && approval.actor !== 'project-local-invocation'
    && approval.decision === 'approved' && approval.projectId === project.id && approval.target === target && approval.candidateDigest === candidateDigest,
    'RELEASE_PROMOTION_DECISION_REQUIRED', 'Formal release approval must bind the exact candidate.');
  const root = releaseRoot(dataRoot, project.id, target);
  return withDirectoryLock(resolve(root, '.lock'), async () => {
    const { state, candidate } = await readVersionRelease({ dataRoot, projectId: project.id, target });
    const previousCommand = state.commands?.[commandId];
    if (previousCommand) {
      assert(previousCommand.candidateDigest === candidateDigest, 'COMMAND_ID_REUSED', 'Promotion command ID was reused for another candidate.');
      return { state, candidate, receipt: previousCommand };
    }
    assert(state.status === 'prereleased' && state.candidateDigest === candidateDigest && state.revision === expectedRevision, 'RELEASE_PROMOTION_STATE_MISMATCH', 'Promotion must target the current frozen prerelease revision.');
    // Promotion commits only the already frozen candidate. A source-link Harness
    // update may rebind the Project Descriptor without changing candidate bytes.
    // The workspace snapshot and staged artifacts below remain the authority for
    // what the user approved.
    const snapshot = await captureWorkspace(workspaceRoot, { excluded: project.workspace.excluded ?? [] });
    assert(snapshot.digest === candidate.sourceDigest, 'RELEASE_PROMOTION_SOURCE_DRIFT', 'Promotion cannot change or rebuild the frozen source.');
    for (const artifact of candidate.artifacts) {
      const file = assertNoLinkPath(root, resolve(root, 'candidates', candidateDigest, 'artifacts', artifact.path), 'frozen release artifact');
      assert(sha256(await readFile(file)) === artifact.sha256, 'RELEASE_PROMOTION_ARTIFACT_DRIFT', `Frozen artifact changed: ${artifact.path}`);
    }
    const receiptBody = { protocolVersion: '1.0', kind: 'version-release-promotion', projectId: project.id, target,
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
