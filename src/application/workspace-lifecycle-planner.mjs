import { assert } from '../common/errors.mjs';
import { workspaceProjectionId } from '../platform/workspace/workspace-registry.mjs';
import { captureSourceManifest } from '../platform/workflow/source-manifest.mjs';

/** Resolve one approved Workspace binding into an immutable lifecycle planning input. */
export const createWorkspaceLifecyclePlanner = ({ workspaceId, workspaceRegistry, resourceProviders, workspacePlanToken, createLifecyclePlan }) => async input => {
  const selectedWorkspaceId = input.workspaceId ?? (await workspaceRegistry.resolveAlias(input.workspaceAlias)).workspaceId;
  assert(!workspaceId || workspaceId === selectedWorkspaceId, 'WORKSPACE_HARNESS_SCOPE_DENIED', 'Harness is bound to another Workspace.');
  assert(workspaceId === selectedWorkspaceId, 'WORKSPACE_HARNESS_REQUIRED', 'Create a Harness scoped to the selected Workspace before planning.');
  const workspace = await workspaceRegistry.get(selectedWorkspaceId);
  if (input.workspaceAlias) assert(workspace.alias === input.workspaceAlias, 'WORKSPACE_ALIAS_STALE', 'Workspace alias changed.');
  const binding = input.workflowId ? workspace.workflows.find(item => item.id === input.workflowId) : workspace.workflows.length === 1 ? workspace.workflows[0] : null;
  assert(binding, input.workflowId ? 'WORKSPACE_WORKFLOW_UNKNOWN' : 'WORKSPACE_WORKFLOW_AMBIGUOUS', 'Select a bound Workspace Workflow explicitly.');
  const projectIds = input.projectIds ?? binding.defaultProjectScope;
  assert(Array.isArray(projectIds) && projectIds.length > 0 && new Set(projectIds).size === projectIds.length && projectIds.every(id => binding.allowedProjectIds.includes(id)), 'WORKSPACE_PROJECT_SCOPE_DENIED', 'Selected Projects are outside the Workflow Binding.');
  const targetId = input.executionTargetId ?? binding.executionTargetId;
  assert(targetId === binding.executionTargetId, 'WORKSPACE_TARGET_DENIED', 'Workflow Binding fixes the execution target.');
  const target = workspace.executionTargets.find(item => item.id === targetId);
  assert(projectIds.every(id => target.projectIds.includes(id)), 'WORKSPACE_TARGET_PROJECT_DENIED', 'Execution target cannot serve the selected Projects.');
  const projectionId = workspaceProjectionId(workspace.workspaceId, targetId);
  const workflowInput = structuredClone(input.workflowInput ?? {});
  assert(!['sourceManifest', 'memorySpaces', 'memorySnapshot', 'workspaceRef'].some(key => Object.hasOwn(workflowInput, key)), 'WORKSPACE_MANAGED_INPUT_DENIED', 'Sources, resources, and Workspace identity are resolved from approved bindings.');
  const selectedSources = workspace.sources.filter(source => projectIds.some(projectId => workspace.projects.find(project => project.id === projectId).sourceIds.includes(source.sourceId)));
  const selectedResources = workspace.resources.filter(resource => resource.kind === 'memory' && (resource.scope === 'project' ? projectIds.includes(resource.projectId) && resource.readProjectIds.includes(resource.projectId) : projectIds.every(id => resource.readProjectIds.includes(id))) && (resource.scope !== 'workflow' && resource.scope !== 'source' && resource.scope !== 'session' || resource.workflowId === binding.id) && (resource.scope !== 'source' || selectedSources.some(source => source.sourceId === resource.sourceId)));
  const workspaceRef = { workspaceId: workspace.workspaceId, revision: workspace.revision, descriptorDigest: workspace.descriptorDigest, alias: workspace.alias, workflowId: binding.id, projectIds: [...projectIds].sort(), executionTargetId: targetId, resourceIds: selectedResources.map(resource => resource.id).sort() };
  if (selectedSources.length) {
    workflowInput.sourceManifest = await captureSourceManifest({ projectId: projectionId, workspaceRef, projectIds, sources: selectedSources });
    workflowInput.memorySpaces = selectedResources.map(resource => resourceProviders.resolve(resource).resolveSpace({ binding: resource, workspaceRef, projectId: projectionId, sessionId: workflowInput.sessionId ?? null }));
  } else assert(!Object.keys(workflowInput).length, 'WORKSPACE_SOURCE_REQUIRED', 'Workflow input requires configured Workspace Sources.');
  return createLifecyclePlan({ ...input, workspaceId: undefined, workspaceAlias: undefined, projectId: projectionId, workflowId: binding.id, extensionId: binding.extensionId, profileId: binding.profileId, executionWorkspaceRoot: target.root, ...(selectedSources.length ? { workflowInput } : {}), workspaceRef, [workspacePlanToken]: true });
};
