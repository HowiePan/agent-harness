import { WorkspaceRegistry } from '../../../platform/workspace/workspace-registry.mjs';

export const handleWorkspaceCommand = async ({ subject, dataRoot, controlRoot, take, jsonFile, jsonInput }) => {
  if (!['register', 'list', 'show', 'rollback'].includes(subject)) return false;
  const registry = new WorkspaceRegistry({ root: dataRoot, controlRoot });
  const workspace = subject === 'list' ? await registry.list()
    : subject === 'show' ? await registry.get(take('--workspace-id'))
    : subject === 'register' ? await registry.register(await jsonInput('--input'), { expectedRevision: Number(take('--expected-revision') ?? 0), commandId: take('--command-id'), authorityDecision: await jsonFile(take('--decision')) })
    : await registry.rollback(take('--workspace-id'), Number(take('--revision')), { commandId: take('--command-id'), authorityDecision: await jsonFile(take('--decision')) });
  console.log(JSON.stringify({ ok: true, [subject === 'list' ? 'workspaces' : 'workspace']: workspace }, null, 2));
  return true;
};
