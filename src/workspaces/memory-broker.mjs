import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digestJson } from '../canonical.mjs';
import { assert } from '../errors.mjs';
import { defineMemorySpace } from '../memory/memory-store.mjs';
import { verifySourceManifest } from '../workflows/source-manifest.mjs';

/** Workspace-scoped Resource Broker for the reference Memory Provider. */
export const createWorkspaceMemoryBroker = ({ workspaceId, workspaceRegistry, providerRegistry, memoryStore, authorityStore }) => {
  const resolveBinding = async (spaceInput, { ref = null, write = false } = {}) => {
    const space = defineMemorySpace(spaceInput);
    const match = /^workspace:([a-z][a-z0-9-]*):resource:([a-z][a-z0-9-]*)$/.exec(space.domainId);
    assert(match && match[1] === workspaceId, 'WORKSPACE_MEMORY_SPACE_DENIED', 'Memory Space belongs to another Workspace or is not bound to a Resource.');
    const workspace = await workspaceRegistry.get(workspaceId);
    const binding = workspace.resources.find(item => item.id === match[2] && item.kind === 'memory');
    assert(binding, 'WORKSPACE_RESOURCE_ACCESS_REVOKED', 'Memory Resource Binding is unavailable.');
    const provider = providerRegistry.resolve(binding);
    const expected = provider.resolveSpace({ binding, workspaceRef: { workspaceId }, projectId: space.projectId, sessionId: space.sessionId });
    assert(space.spaceId === expected.spaceId, 'WORKSPACE_MEMORY_SPACE_DENIED', 'Memory Space does not match its Workspace Resource Binding.');
    if (ref) {
      assert(ref.workspaceId === workspaceId && ref.projectIds?.length && ref.projectIds.every(id => workspace.projects.some(project => project.id === id)), 'WORKSPACE_RESOURCE_SCOPE_DENIED', 'Run Project scope is invalid.');
      const permitted = binding.scope === 'project'
        ? ref.projectIds.includes(binding.projectId) && binding[write ? 'writeProjectIds' : 'readProjectIds'].includes(binding.projectId)
        : ref.projectIds.every(id => binding[write ? 'writeProjectIds' : 'readProjectIds'].includes(id));
      assert(permitted, 'WORKSPACE_RESOURCE_SCOPE_DENIED', 'Project scope cannot access this Memory Resource.');
      if (['workflow', 'source', 'session'].includes(binding.scope)) assert(binding.workflowId === ref.workflowId, 'WORKSPACE_RESOURCE_WORKFLOW_DENIED', 'Memory Resource belongs to another Workflow.');
    }
    return { space, binding, workspace };
  };
  const runRef = async ({ projectId, runId }) => {
    assert(projectId && runId, 'WORKSPACE_MEMORY_RUN_REQUIRED', 'Memory writes require an authorized Run.');
    const state = await authorityStore.read(projectId, runId);
    assert(state.metadata?.workspaceRef?.workspaceId === workspaceId, 'WORKSPACE_MEMORY_RUN_DENIED', 'Run belongs to another Workspace.');
    return state.metadata.workspaceRef;
  };
  const checkedWrite = (method, args) => (async () => {
    const ref = await runRef(args);
    await resolveBinding(args.space, { ref, write: true });
    return memoryStore[method](args);
  })();
  return Object.freeze({
    async query(args) {
      const manifest = verifySourceManifest(args.manifest);
      const ref = manifest.workspaceRef;
      assert(ref?.workspaceId === workspaceId && ref.descriptorDigest === (await workspaceRegistry.get(workspaceId)).descriptorDigest && manifest.projectId === args.projectId, 'WORKSPACE_MEMORY_MANIFEST_DENIED', 'Memory query requires a current Workspace Source Manifest.');
      for (const space of args.spaces) await resolveBinding(space, { ref });
      return memoryStore.query(args);
    },
    async read(space, context) {
      const ref = await runRef(context);
      await resolveBinding(space, { ref });
      return memoryStore.read(space);
    },
    propose: args => checkedWrite('propose', args),
    stageFromSubmission: args => checkedWrite('stageFromSubmission', args),
    promote: args => checkedWrite('promote', args),
    revoke: args => checkedWrite('revoke', args),
    rejectAnswer: args => checkedWrite('rejectAnswer', args),
    exportVerified: args => checkedWrite('exportVerified', args),
    importUnverified: args => checkedWrite('importUnverified', args),
    async recoverPendingPromotions() {
      let files;
      try { files = await readdir(resolve(memoryStore.root, 'effects')); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      for (const file of files.filter(name => name.endsWith('.json'))) {
        const effect = JSON.parse(await readFile(resolve(memoryStore.root, 'effects', file), 'utf8'));
        if (effect.status !== 'pending') continue;
        const ref = await runRef(effect);
        await resolveBinding(effect.space, { ref, write: true });
      }
      return memoryStore.recoverPendingPromotions();
    },
    effectFile(commandId) { return memoryStore.effectFile(commandId); },
    identityDigest: digestJson({ kind: 'workspace-memory-broker', version: '1.0.0' }),
  });
};
