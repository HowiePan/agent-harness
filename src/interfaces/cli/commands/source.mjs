import { createHarness } from '../../../application/harness.mjs';
import { AuthorityStore } from '../../../kernel/authority-store.mjs';
import { captureSourceManifest } from '../../../platform/workflow/source-manifest.mjs';
import { readSourceForDispatch, searchSourceForDispatch } from '../../../platform/workflow/source-tool.mjs';

export const handleSourceCommand = async ({ subject, runDataRoot, controlRoot, dataRoot, scopedWorkspaceId, releaseIdentity, take, optionalNumber, jsonInput }) => {
  if (subject === 'capture') {
    console.log(JSON.stringify({ ok: true, manifest: await captureSourceManifest(await jsonInput('--input')) }, null, 2));
    return true;
  }
  if (!['read', 'search'].includes(subject)) return false;
  const authorityStore = new AuthorityStore({ root: runDataRoot, controlRoot });
  const scopedHarness = scopedWorkspaceId ? await createHarness({ controlRoot, dataRoot, workspaceId: scopedWorkspaceId, releaseIdentity, initializeStorage: false }) : null;
  const scope = { authorityStore, projectId: take('--project'), runId: take('--run'), dispatchId: take('--dispatch'), ...(scopedHarness ? { readPinned: args => scopedHarness.readPinnedSourceForDispatch(args.projectId, args.runId, args.dispatchId, args.sourceId, args.path) } : {}) };
  const result = subject === 'read'
    ? await readSourceForDispatch({ ...scope, sourceId: take('--source'), path: take('--path') })
    : await searchSourceForDispatch({ ...scope, query: take('--query'), maxMatches: optionalNumber('--max') ?? 50 });
  console.log(JSON.stringify({ ok: true, result }, null, 2));
  return true;
};
