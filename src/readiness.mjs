import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ExtensionRegistry } from './extensions/registry.mjs';
import { AuthorityStore } from './kernel/authority-store.mjs';
import { ProjectRegistry } from './registry/project-registry.mjs';
import { resolveProjectWorkspace } from './workspace-identity.mjs';
import { assertHarnessWritePath, harnessControlRoot, harnessProjectRoot } from './write-boundary.mjs';
import { activeReleaseFile, resolveActiveRegistryRoot } from './registry/active-generation.mjs';

const errorView = error => ({ code: error.code ?? 'UNEXPECTED_ERROR', message: error.message });

const inspectProject = async ({ project, extensionState, extensionVerification, releaseIdentity, profileId, extensionId, executionWorkspaceRoot }) => {
  const issues = [];
  const required = project.extensions ?? [];
  const installedById = new Map(extensionState.extensions.map(item => [item.id, item]));
  const harnessIdentityMatch = project.harness?.version === releaseIdentity.version && project.harness?.artifactDigest === releaseIdentity.artifactDigest;
  if (!harnessIdentityMatch) issues.push({ code: 'PROJECT_HARNESS_IDENTITY_MISMATCH', message: 'Project Descriptor does not bind the active Harness release identity.' });
  const profileBound = profileId ? project.profiles.includes(profileId) : project.profiles.length > 0;
  if (!profileBound) issues.push({ code: 'PROJECT_PROFILE_NOT_BOUND', message: `Project does not bind Profile ${profileId}.` });
  const boundExtensionRequired = extensionId ? required.some(item => item.id === extensionId) : true;
  if (!boundExtensionRequired) issues.push({ code: 'PROJECT_BOUND_EXTENSION_MISSING', message: `Project does not require bound Extension ${extensionId}.` });
  const extensions = required.map(expected => {
    const installed = installedById.get(expected.id);
    const verified = extensionVerification.get(expected.id);
    const identityMatch = Boolean(installed && installed.version === expected.version && installed.digest === expected.digest);
    const artifactVerified = Boolean(verified?.ok);
    if (!installed) issues.push({ code: 'PROJECT_EXTENSION_MISSING', message: `Required Extension is not registered: ${expected.id}` });
    else if (!identityMatch) issues.push({ code: 'PROJECT_EXTENSION_IDENTITY_MISMATCH', message: `Registered Extension does not match Project Descriptor: ${expected.id}` });
    else if (!artifactVerified) issues.push({ code: verified?.error?.code ?? 'PROJECT_EXTENSION_ARTIFACT_INVALID', message: verified?.error?.message ?? `Extension artifact verification failed: ${expected.id}` });
    return { id: expected.id, expected: structuredClone(expected), installed: installed ? structuredClone(installed) : null, identityMatch, artifactVerified };
  });
  let workspace = null;
  try { workspace = await resolveProjectWorkspace(project, executionWorkspaceRoot); }
  catch (error) { issues.push(errorView(error)); }
  return {
    projectId: project.id,
    descriptorDigest: project.descriptorDigest,
    revision: project.revision,
    profileBound,
    boundExtensionRequired,
    harnessIdentityMatch,
    workspace,
    extensions,
    projectReady: issues.length === 0,
    issues,
  };
};

export const inspectLifecycleReadiness = async ({ controlRoot: controlRootInput, dataRoot: dataRootInput, releaseIdentity, projectId, profileId, extensionId, executionWorkspaceRoot } = {}) => {
  const controlRoot = harnessControlRoot(controlRootInput);
  const dataRoot = assertHarnessWritePath(dataRootInput ?? resolve(controlRoot, '.agent-harness-data'), 'Harness dataRoot', controlRoot);
  const extensionRegistry = new ExtensionRegistry({ dataRoot, controlRoot });
  const projectRegistry = new ProjectRegistry({ root: dataRoot, controlRoot });
  const [extensionState, projects] = await Promise.all([extensionRegistry.list(), projectRegistry.list()]);
  const extensionVerification = new Map();
  for (const extension of extensionState.extensions) {
    try {
      await extensionRegistry.loadOneArtifact(extension.id);
      extensionVerification.set(extension.id, { ok: true });
    } catch (error) { extensionVerification.set(extension.id, { ok: false, error: errorView(error) }); }
  }
  const selectedProjects = projectId ? projects.filter(project => project.id === projectId) : projects;
  const projectReadiness = [];
  for (const project of selectedProjects) projectReadiness.push(await inspectProject({ project, extensionState, extensionVerification, releaseIdentity, profileId, extensionId, executionWorkspaceRoot }));
  if (projectId && selectedProjects.length === 0) projectReadiness.push({ projectId, projectReady: false, issues: [{ code: 'PROJECT_NOT_REGISTERED', message: `Project is not registered: ${projectId}` }], extensions: [] });
  const registryRoot = await resolveActiveRegistryRoot(dataRoot, controlRoot);
  const paths = {
    dataRoot: existsSync(dataRoot),
    extensionRegistry: existsSync(resolve(registryRoot, 'extensions.json')),
    projectRegistry: existsSync(resolve(registryRoot, 'projects')),
    authority: existsSync(resolve(dataRoot, 'authority')),
  };
  const activeRelease = existsSync(activeReleaseFile(dataRoot));
  const storageReady = ['dataRoot', 'extensionRegistry', 'projectRegistry', 'authority'].every(key => paths[key]);
  const projectsReady = projectReadiness.length > 0 && projectReadiness.every(item => item.projectReady);
  return {
    protocolVersion: '1.0',
    controlRoot,
    controlRootMode: controlRoot === harnessProjectRoot() ? 'source-checkout' : 'installed',
    dataRoot,
    releaseVerified: Boolean(releaseIdentity?.verified),
    installationReady: true,
    writeCapability: 'not-probed',
    paths,
    activeRelease,
    storageReady,
    extensionRegistryRevision: extensionState.revision,
    registeredExtensions: extensionState.extensions.map(item => ({ ...structuredClone(item), artifactVerified: extensionVerification.get(item.id)?.ok === true })),
    registeredProjects: projects.map(project => ({ id: project.id, revision: project.revision, descriptorDigest: project.descriptorDigest })),
    projectReadiness,
    lifecycleReady: Boolean(releaseIdentity?.verified) && storageReady && projectsReady,
  };
};

export const readRunStatus = async ({ controlRoot: controlRootInput, dataRoot, projectId, runId } = {}) => {
  const controlRoot = harnessControlRoot(controlRootInput);
  const root = assertHarnessWritePath(dataRoot ?? resolve(controlRoot, '.agent-harness-data'), 'Harness dataRoot', controlRoot);
  const authority = await new AuthorityStore({ root, controlRoot }).read(projectId, runId);
  return { authority, projection: null, projectionReason: 'extension-code-not-executed-by-read-only-status' };
};
