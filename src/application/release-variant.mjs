import { assert } from '../common/errors.mjs';
import { loadReleaseDocumentationScope } from './release-documentation-scope.mjs';
import { readDevelopmentClearance, readVersionRelease, promoteVersionRelease } from './version-prerelease.mjs';
import { readBatchClearance, readBatchRelease, promoteBatchRelease } from './batch-prerelease.mjs';

export const releaseKindForExtension = extension => extension.planningCapabilities.includes('batch-release') ? 'scoped' : 'version';

export const readReleaseForKind = ({ kind, ...input }) => kind === 'scoped' ? readBatchRelease(input) : readVersionRelease(input);
export const promoteReleaseForKind = ({ kind, ...input }) => kind === 'scoped' ? promoteBatchRelease(input) : promoteVersionRelease(input);

export const preparePrereleaseIntent = async ({ intent, extension, project, snapshot, workspace, authorityStore, evidenceStore }) => {
  if (releaseKindForExtension(extension) === 'scoped') {
    const release = project.policy?.release;
    assert(release?.artifactRoot && release?.packageGateId && release?.manifestPath
      && project.gateRecipes?.some(recipe => recipe.id === release.packageGateId && recipe.scope === 'final'),
    'BATCH_PRERELEASE_POLICY_REQUIRED', 'Scoped prerelease requires an explicit release policy and final package Gate.');
    const existingRelease = await readBatchRelease({ dataRoot: authorityStore.root, projectId: project.id, target: intent.target });
    assert(existingRelease.state.status !== 'released', 'BATCH_ALREADY_RELEASED', 'A released scoped target cannot start a new prerelease.');
    assert(existingRelease.state.status !== 'prereleased' || existingRelease.candidate.sourceDigest !== snapshot.digest,
      'BATCH_PRERELEASE_ALREADY_FROZEN', 'The current source already has a frozen candidate.');
    return { ...intent, batchClearance: await readBatchClearance({ dataRoot: authorityStore.root, project,
      workflowId: intent.workflowId, target: intent.target,
      runs: await authorityStore.list(project.id), sourceDigest: snapshot.digest }) };
  }
  const existingRelease = await readVersionRelease({ dataRoot: authorityStore.root, projectId: project.id, target: intent.target });
  assert(existingRelease.state.status !== 'released', 'VERSION_ALREADY_RELEASED', 'A released version cannot start a new prerelease.');
  assert(existingRelease.state.status !== 'prereleased' || existingRelease.candidate.sourceDigest !== snapshot.digest,
    'PRERELEASE_ALREADY_FROZEN', 'The current source already has a frozen candidate; inspect it with version-release status.');
  const release = project.policy?.release;
  assert(release?.documentationScopePath && Array.isArray(release.versionPaths) && release.artifactRoot && release.packageGateId,
    'PRERELEASE_POLICY_REQUIRED', 'Project must declare release documentation, version paths, artifact root, and package Gate.');
  const documentation = await loadReleaseDocumentationScope({ workspaceRoot: workspace.root, configPath: release.documentationScopePath, excluded: project.workspace.excluded ?? [] });
  const clearance = await readDevelopmentClearance({ dataRoot: authorityStore.root, projectId: project.id, target: intent.target,
    runs: await authorityStore.list(project.id), evidenceStore, currentSnapshot: snapshot,
    allowedPaths: [...documentation.allowedPaths, ...release.versionPaths, release.documentationScopePath], excluded: project.workspace.excluded ?? [] });
  return { ...intent, releaseDocumentation: documentation, developmentClearance: clearance.receipt,
    authorizedPreReleaseDelta: clearance.authorizedPreReleaseDelta };
};
