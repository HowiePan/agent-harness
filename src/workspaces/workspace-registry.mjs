import { readFileSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { digestJson, withoutKeys } from '../canonical.mjs';
import { assert, fail } from '../errors.mjs';
import { assertJsonSchema } from '../json-schema.mjs';
import { atomicWriteJson, readJson, withDirectoryLock } from '../kernel/atomic-io.mjs';
import { assertNoLinkPath, safeSegment } from '../paths.mjs';
import { assertProjectDescriptorInput, projectDescriptorInput } from '../registry/project-contract.mjs';
import { assertHarnessWritePath, harnessControlRoot } from '../write-boundary.mjs';

const idPattern = /^[a-z][a-z0-9-]{0,31}$/;
const sha = /^[a-f0-9]{64}$/;
const semver = /^\d+\.\d+\.\d+$/;
const unique = values => new Set(values).size === values.length;
const descriptorSchema = JSON.parse(readFileSync(new URL('../../schemas/workspace-descriptor.schema.json', import.meta.url), 'utf8'));
const inside = (parent, child) => { const path = relative(parent, child); return path === '' || (!path.startsWith('..') && !isAbsolute(path)); };

export const workspaceProjectionId = (workspaceId, targetId) => {
  assert(idPattern.test(workspaceId ?? '') && idPattern.test(targetId ?? ''), 'WORKSPACE_PROJECTION_INVALID', 'Workspace projection requires safe IDs.');
  return `ws.${workspaceId}.${targetId}`;
};
export const parseWorkspaceProjectionId = id => {
  const match = /^ws\.([a-z][a-z0-9-]{0,31})\.([a-z][a-z0-9-]{0,31})$/.exec(String(id));
  return match ? { workspaceId: match[1], targetId: match[2] } : null;
};

export const validateWorkspaceDescriptor = input => {
  assertJsonSchema(input, descriptorSchema, { code: 'WORKSPACE_DESCRIPTOR_SCHEMA_INVALID', label: 'Workspace Descriptor' });
  assert(input?.schemaVersion === '1.0' && idPattern.test(input.workspaceId ?? '') && idPattern.test(input.alias ?? ''), 'WORKSPACE_DESCRIPTOR_INVALID', 'Workspace requires versioned stable ID and alias.');
  const allowed = ['schemaVersion', 'workspaceId', 'alias', 'harness', 'profiles', 'extensions', 'workflows', 'policy', 'gateRecipes', 'artifactProviders', 'projects', 'sources', 'executionTargets', 'resources'];
  assert(Object.keys(input).every(key => allowed.includes(key)), 'WORKSPACE_DESCRIPTOR_UNKNOWN_FIELD', 'Workspace Descriptor contains an unknown field.');
  assert(Array.isArray(input.projects) && input.projects.length > 0 && input.projects.length <= 100 && unique(input.projects.map(item => item.id)), 'WORKSPACE_PROJECTS_INVALID', 'Workspace requires unique member Projects.');
  assert(Array.isArray(input.sources) && input.sources.length <= 100 && unique(input.sources.map(item => item.sourceId)), 'WORKSPACE_SOURCES_INVALID', 'Workspace sources must have unique IDs.');
  assert(Array.isArray(input.executionTargets) && input.executionTargets.length > 0 && unique(input.executionTargets.map(item => item.id)), 'WORKSPACE_TARGETS_INVALID', 'Workspace requires unique execution targets.');
  assert(Array.isArray(input.workflows) && input.workflows.length > 0 && unique(input.workflows.map(item => item.id)), 'WORKSPACE_WORKFLOWS_INVALID', 'Workspace requires unique bound workflows.');
  assert(Array.isArray(input.resources ?? []) && unique((input.resources ?? []).map(item => item.id)), 'WORKSPACE_RESOURCES_INVALID', 'Workspace resources must have unique IDs.');
  const projects = new Set(input.projects.map(item => item.id));
  const sources = new Set(input.sources.map(item => item.sourceId));
  const targets = new Set(input.executionTargets.map(item => item.id));
  const workflows = new Set(input.workflows.map(item => item.id));
  for (const project of input.projects) {
    assert(idPattern.test(project?.id ?? '') && Array.isArray(project.sourceIds) && project.sourceIds.every(id => sources.has(id)) && Array.isArray(project.executionTargetIds) && project.executionTargetIds.length > 0 && project.executionTargetIds.every(id => targets.has(id)), 'WORKSPACE_PROJECT_INVALID', 'Member Project references an unknown source or execution target.');
    assert(project.sourceIds.every(id => { const source = input.sources.find(item => item.sourceId === id); return source.ownerProjectId === project.id || source.sharedProjectIds?.includes(project.id); }), 'WORKSPACE_SOURCE_PROJECT_DENIED', 'Project cannot select another Project source without explicit sharing.');
  }
  for (const source of input.sources) {
    assert(idPattern.test(source?.sourceId ?? '') && ['repository', 'document'].includes(source.type) && isAbsolute(source.root ?? '') && projects.has(source.ownerProjectId) && Array.isArray(source.allowedReceivers) && source.allowedReceivers.length > 0 && unique(source.allowedReceivers), 'WORKSPACE_SOURCE_INVALID', 'Workspace source requires an owner, absolute root, and receiver allowlist.');
    assert(source.allowedPaths === undefined || Array.isArray(source.allowedPaths) && source.allowedPaths.every(path => typeof path === 'string' && path && !path.startsWith('/') && !path.includes('..') && !path.includes('\\')), 'WORKSPACE_SOURCE_SCOPE_INVALID', 'Source allowed paths must be safe relative paths.');
    assert(source.sharedProjectIds === undefined || Array.isArray(source.sharedProjectIds) && source.sharedProjectIds.every(id => projects.has(id)) && unique(source.sharedProjectIds), 'WORKSPACE_SOURCE_SHARE_INVALID', 'Source sharing must list member Projects.');
    assertNoLinkPath(source.root, source.root, 'Workspace Source root');
  }
  for (const target of input.executionTargets) {
    assert(idPattern.test(target?.id ?? '') && isAbsolute(target.root ?? '') && Array.isArray(target.projectIds) && target.projectIds.length > 0 && target.projectIds.every(id => projects.has(id)), 'WORKSPACE_TARGET_INVALID', 'Execution target requires an absolute root and authorized Projects.');
    assertNoLinkPath(target.root, target.root, 'Workspace execution target');
  }
  for (const workflow of input.workflows) {
    assert(idPattern.test(workflow?.id ?? '') && semver.test(workflow.version ?? '') && sha.test(workflow.artifactDigest ?? '') && workflow.extensionId && workflow.profileId && targets.has(workflow.executionTargetId), 'WORKSPACE_WORKFLOW_INVALID', 'Workflow Binding requires an exact artifact and execution target.');
    assert(Array.isArray(workflow.allowedProjectIds) && workflow.allowedProjectIds.length > 0 && workflow.allowedProjectIds.every(id => projects.has(id)) && unique(workflow.allowedProjectIds), 'WORKSPACE_WORKFLOW_PROJECTS_INVALID', 'Workflow allowed Projects are invalid.');
    assert(Array.isArray(workflow.defaultProjectScope ?? []) && (workflow.defaultProjectScope ?? []).every(id => workflow.allowedProjectIds.includes(id)) && unique(workflow.defaultProjectScope ?? []), 'WORKSPACE_WORKFLOW_DEFAULT_INVALID', 'Workflow default Project scope is invalid.');
    const target = input.executionTargets.find(item => item.id === workflow.executionTargetId);
    assert(workflow.allowedProjectIds.every(id => target.projectIds.includes(id)), 'WORKSPACE_WORKFLOW_TARGET_DENIED', 'Execution target does not allow every Workflow Project.');
  }
  for (const resource of input.resources ?? []) {
    assert(idPattern.test(resource?.id ?? '') && ['workspace', 'project', 'workflow', 'source', 'session'].includes(resource.scope) && resource.kind && resource.providerRef?.id && semver.test(resource.providerRef?.version ?? '') && sha.test(resource.providerRef?.artifactDigest ?? ''), 'WORKSPACE_RESOURCE_INVALID', 'Resource Binding requires scope and exact Provider identity.');
    if (resource.scope === 'project') assert(projects.has(resource.projectId), 'WORKSPACE_RESOURCE_PROJECT_INVALID', 'Project resource requires a member Project.');
    if (['workflow', 'source', 'session'].includes(resource.scope)) assert(workflows.has(resource.workflowId), 'WORKSPACE_RESOURCE_WORKFLOW_INVALID', 'Scoped resource requires a bound Workflow.');
    if (resource.scope === 'source') assert(sources.has(resource.sourceId), 'WORKSPACE_RESOURCE_SOURCE_INVALID', 'Source resource requires a bound Source.');
    assert(Array.isArray(resource.readProjectIds) && resource.readProjectIds.length > 0 && resource.readProjectIds.every(id => projects.has(id)) && unique(resource.readProjectIds), 'WORKSPACE_RESOURCE_READ_SCOPE_INVALID', 'Resource readers must be member Projects.');
    assert(Array.isArray(resource.writeProjectIds) && resource.writeProjectIds.every(id => resource.readProjectIds.includes(id)) && unique(resource.writeProjectIds), 'WORKSPACE_RESOURCE_WRITE_SCOPE_INVALID', 'Resource writers must be permitted readers.');
    if (resource.scope === 'project') assert(resource.readProjectIds.every(id => id === resource.projectId), 'WORKSPACE_PROJECT_RESOURCE_LEAK', 'Project resource cannot be shared with another Project.');
  }
  assert(Array.isArray(input.profiles) && input.profiles.length > 0 && Array.isArray(input.extensions), 'WORKSPACE_COMPOSITION_INVALID', 'Workspace requires Profiles and Extensions.');
  assert(input.workflows.every(workflow => input.profiles.includes(workflow.profileId) && input.extensions.some(extension => extension.id === workflow.extensionId && extension.version && extension.digest)), 'WORKSPACE_WORKFLOW_BINDING_INVALID', 'Workflow must bind an installed Profile and Extension.');
  assert(input.policy && Array.isArray(input.gateRecipes ?? []) && Array.isArray(input.artifactProviders ?? []), 'WORKSPACE_POLICY_INVALID', 'Workspace policy, Gates, and Artifact Providers are invalid.');
  for (const target of input.executionTargets) {
    const projection = projectDescriptorFromWorkspace({ ...input, revision: 1, descriptorDigest: digestJson(input) }, target.id);
    assertProjectDescriptorInput(projectDescriptorInput(projection), { strictIdentity: Boolean(input.harness?.artifactDigest) });
  }
  return structuredClone(input);
};

export const projectDescriptorFromWorkspace = (workspace, targetId) => {
  const target = workspace.executionTargets.find(item => item.id === targetId);
  assert(target, 'WORKSPACE_TARGET_UNKNOWN', `Unknown execution target ${targetId}.`);
  const body = {
    id: workspaceProjectionId(workspace.workspaceId, targetId),
    ...(workspace.harness ? { harness: structuredClone(workspace.harness) } : {}),
    workspace: { root: target.root, ...(target.rootSelector ? { rootSelector: target.rootSelector } : {}), ...(target.excluded ? { excluded: structuredClone(target.excluded) } : {}) },
    profiles: structuredClone(workspace.profiles),
    extensions: structuredClone(workspace.extensions),
    workflows: workspace.workflows.filter(workflow => workflow.executionTargetId === targetId).map(({ id, version, artifactDigest, extensionId }) => ({ id, version, artifactDigest, extensionId })),
    policy: structuredClone(workspace.policy),
    gateRecipes: structuredClone(workspace.gateRecipes ?? []),
    artifactProviders: structuredClone(workspace.artifactProviders ?? []),
  };
  const revision = workspace.revision;
  const descriptorDigest = digestJson({ workspaceId: workspace.workspaceId, workspaceDigest: workspace.descriptorDigest, targetId, body });
  return { ...body, revision, descriptorDigest };
};

export const workspaceDecisionContext = ({ current = null, input, expectedRevision = current?.revision ?? 0 }) => ({ workspaceId: input.workspaceId, expectedRevision, previousDigest: current?.descriptorDigest ?? null, nextDigest: digestJson(input) });

/** One-to-one compatibility view for legacy Project Descriptors. No old state is moved. */
export const workspaceFromProjectDescriptor = (project, { workspaceId, alias = workspaceId, memberProjectId = project.id, targetId = 'primary' } = {}) => {
  assert(project?.workspace?.root && project.profiles?.length === 1 && project.workflows?.length === 1, 'WORKSPACE_COMPAT_PROJECT_AMBIGUOUS', 'Legacy Project conversion requires one Profile and one bound Workflow.');
  const descriptor = {
    schemaVersion: '1.0', workspaceId, alias,
    ...(project.harness ? { harness: structuredClone(project.harness) } : {}),
    profiles: structuredClone(project.profiles), extensions: structuredClone(project.extensions ?? []),
    workflows: project.workflows.map(workflow => ({ ...structuredClone(workflow), profileId: project.profiles[0], allowedProjectIds: [memberProjectId], defaultProjectScope: [memberProjectId], executionTargetId: targetId })),
    projects: [{ id: memberProjectId, sourceIds: [], executionTargetIds: [targetId] }],
    sources: [], executionTargets: [{ id: targetId, root: project.workspace.root, ...(project.workspace.rootSelector ? { rootSelector: project.workspace.rootSelector } : {}), ...(project.workspace.excluded ? { excluded: structuredClone(project.workspace.excluded) } : {}), projectIds: [memberProjectId] }],
    resources: [], policy: structuredClone(project.policy), gateRecipes: structuredClone(project.gateRecipes ?? []), artifactProviders: structuredClone(project.artifactProviders ?? []),
  };
  return validateWorkspaceDescriptor(descriptor);
};

export class WorkspaceRegistry {
  constructor({ root, controlRoot, now = () => new Date().toISOString() }) {
    this.controlRoot = harnessControlRoot(controlRoot);
    this.root = assertHarnessWritePath(root, 'Workspace Registry root', this.controlRoot);
    this.directory = resolve(this.root, 'registry', 'workspaces');
    this.now = now;
  }
  workspaceDirectory(id) { return assertHarnessWritePath(resolve(this.directory, safeSegment(id, 'workspaceId')), 'Workspace record', this.controlRoot); }
  stateFile(id) { return resolve(this.workspaceDirectory(id), 'active.json'); }
  revisionFile(id, revision) { return resolve(this.workspaceDirectory(id), 'revisions', `${revision}.json`); }

  async get(id, { required = true } = {}) {
    const state = await readJson(this.stateFile(id), null);
    if (!state) { if (required) fail('WORKSPACE_NOT_FOUND', `Workspace not found: ${id}`); return null; }
    assert(state.stateDigest === digestJson(withoutKeys(state, ['stateDigest'])), 'WORKSPACE_STATE_DIGEST_MISMATCH', 'Workspace active state digest is invalid.');
    assert(state.schemaVersion === '1.0' && state.workspaceId === id && state.descriptorDigest === digestJson(state.descriptor), 'WORKSPACE_DIGEST_MISMATCH', 'Workspace active record digest is invalid.');
    const revision = await readJson(this.revisionFile(id, state.revision), null);
    assert(revision?.descriptorDigest === state.descriptorDigest && digestJson(revision.descriptor) === state.descriptorDigest, 'WORKSPACE_REVISION_MISSING', 'Workspace active revision is missing or changed.');
    validateWorkspaceDescriptor(state.descriptor);
    return { ...structuredClone(state.descriptor), revision: state.revision, descriptorDigest: state.descriptorDigest, registeredAt: state.registeredAt };
  }

  async list() {
    let entries;
    try { entries = await readdir(this.directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return Promise.all(entries.filter(item => item.isDirectory() && idPattern.test(item.name)).map(item => this.get(item.name)));
  }

  async resolveAlias(alias) {
    const matches = (await this.list()).filter(item => item.alias === alias);
    assert(matches.length <= 1, 'WORKSPACE_ALIAS_DUPLICATE', 'Workspace alias is ambiguous.');
    if (!matches.length) fail('WORKSPACE_ALIAS_UNKNOWN', `Unknown Workspace alias: ${alias}`);
    return matches[0];
  }

  async register(input, { expectedRevision = 0, commandId, authorityDecision } = {}) {
    const descriptor = validateWorkspaceDescriptor(input);
    assert(commandId, 'COMMAND_ID_REQUIRED', 'Workspace registration requires a command ID.');
    const payloadDigest = digestJson(descriptor);
    await mkdir(this.directory, { recursive: true });
    return withDirectoryLock(resolve(this.directory, '.registry.lock'), async () => {
      const current = await this.get(descriptor.workspaceId, { required: false });
      const state = await readJson(this.stateFile(descriptor.workspaceId), null);
      const prior = state?.commands?.[commandId];
      if (prior) {
        assert(prior.payloadDigest === payloadDigest, 'COMMAND_ID_REUSED', 'Workspace command ID was reused.');
        return current;
      }
      assert((current?.revision ?? 0) === expectedRevision, 'WORKSPACE_REVISION_CONFLICT', 'Workspace Descriptor revision changed.');
      const all = await this.list();
      assert(!all.some(item => item.alias === descriptor.alias && item.workspaceId !== descriptor.workspaceId), 'WORKSPACE_ALIAS_DUPLICATE', 'Another Workspace already uses this alias.');
      for (const project of descriptor.projects) assert(!all.some(item => item.workspaceId !== descriptor.workspaceId && item.projects.some(other => other.id === project.id)), 'WORKSPACE_PROJECT_OWNER_CONFLICT', `Member Project ${project.id} already belongs to another Workspace.`);
      for (const target of descriptor.executionTargets) {
        const dataRelative = relative(resolve(target.root), this.root);
        assert(dataRelative.startsWith('..') || isAbsolute(dataRelative), 'STATE_ROOT_INSIDE_WORKSPACE', 'Harness dataRoot must not be inside a Workspace execution target.');
        const normalized = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
        assert(!all.some(item => item.workspaceId !== descriptor.workspaceId && item.executionTargets.some(other => inside(normalized(other.root), normalized(target.root)) || inside(normalized(target.root), normalized(other.root)))), 'WORKSPACE_TARGET_CONFLICT', 'Execution target overlaps another Workspace write target.');
      }
      const context = workspaceDecisionContext({ current, input: descriptor, expectedRevision });
      assert(authorityDecision?.actor && authorityDecision.decision === 'approved' && authorityDecision.action === 'workspace-register' && digestJson(authorityDecision.context) === digestJson(context) && Date.parse(authorityDecision.expiresAt ?? '') > Date.parse(this.now()), 'WORKSPACE_DECISION_REQUIRED', 'Workspace registration requires an exact, unexpired Authority Decision.');
      const revision = expectedRevision + 1;
      const revisionFile = this.revisionFile(descriptor.workspaceId, revision);
      const pending = await readJson(revisionFile, null);
      assert(!pending || pending.descriptorDigest === payloadDigest, 'WORKSPACE_REVISION_COLLISION', 'Workspace revision was already staged with different content.');
      const registeredAt = pending?.registeredAt ?? this.now();
      const revisionRecord = { schemaVersion: '1.0', workspaceId: descriptor.workspaceId, revision, descriptor, descriptorDigest: payloadDigest, registeredAt, decision: structuredClone(authorityDecision) };
      if (!pending) await atomicWriteJson(revisionFile, revisionRecord, { root: this.controlRoot });
      const commands = { ...(state?.commands ?? {}), [commandId]: { payloadDigest, revision, committedAt: registeredAt } };
      const active = { schemaVersion: '1.0', workspaceId: descriptor.workspaceId, revision, descriptor, descriptorDigest: payloadDigest, registeredAt, commands };
      await atomicWriteJson(this.stateFile(descriptor.workspaceId), { ...active, stateDigest: digestJson(active) }, { root: this.controlRoot });
      return this.get(descriptor.workspaceId);
    }, { root: this.controlRoot });
  }

  async rollback(id, revision, options) {
    const record = await readJson(this.revisionFile(id, revision), null);
    assert(record?.descriptorDigest === digestJson(record.descriptor), 'WORKSPACE_REVISION_MISSING', 'Rollback target revision is invalid.');
    const current = await this.get(id);
    return this.register(record.descriptor, { ...options, expectedRevision: current.revision });
  }
}
