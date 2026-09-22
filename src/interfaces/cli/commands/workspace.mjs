import { WorkspaceRegistry } from '../../../platform/workspace/workspace-registry.mjs';

export const handleWorkspaceCommand = async ({ subject, dataRoot, controlRoot, take, jsonFile, jsonInput }) => {
  if (!['register', 'list', 'show', 'rollback'].includes(subject)) return false;
  const registry = new WorkspaceRegistry({ root: dataRoot, controlRoot });
  let workspace;
  if (subject === 'list') {
    workspace = await registry.list();
  } else if (subject === 'show') {
    workspace = await registry.get(take('--workspace-id'));
  } else if (subject === 'register') {
    const input = await jsonInput('--input');
    const current = await registry.get(input.workspaceId, { required: false });
    const expectedRevision = Number(take('--expected-revision') ?? current?.revision ?? 0);
    const commandId = take('--command-id') ?? `register-${Date.now()}`;
    const authorityDecision = take('--decision') ? await jsonFile(take('--decision')) : null;
    workspace = await registry.register(input, { expectedRevision, commandId, authorityDecision });
  } else if (subject === 'rollback') {
    const workspaceId = take('--workspace-id');
    const revision = Number(take('--revision'));
    const commandId = take('--command-id') ?? `rollback-${Date.now()}`;
    const authorityDecision = take('--decision') ? await jsonFile(take('--decision')) : null;
    workspace = await registry.rollback(workspaceId, revision, { commandId, authorityDecision });
  }
  console.log(JSON.stringify({ ok: true, [subject === 'list' ? 'workspaces' : 'workspace']: workspace }, null, 2));
  return true;
};
