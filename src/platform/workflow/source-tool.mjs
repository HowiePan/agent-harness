import { assert } from '../../common/errors.mjs';
import { readPinnedSource } from './source-manifest.mjs';

const liveDispatch = (state, dispatchId, sourceId) => {
  const dispatch = state.dispatches.find(item => item.dispatchId === dispatchId && ['requested', 'assigned'].includes(item.status));
  assert(dispatch, 'SOURCE_DISPATCH_INVALID', 'Pinned source operation requires a live Dispatch.');
  assert((dispatch.featureSnapshot?.metadata?.sourceIds ?? []).includes(sourceId), 'SOURCE_FEATURE_SCOPE_DENIED', `Feature cannot read source ${sourceId}.`);
  return dispatch;
};

export const readSourceForDispatch = async ({ authorityStore, projectId, runId, dispatchId, sourceId, path, readPinned = null }) => {
  const state = await authorityStore.read(projectId, runId);
  const dispatch = liveDispatch(state, dispatchId, sourceId);
  const pinned = readPinned ? await readPinned({ projectId, runId, dispatchId, sourceId, path }) : await readPinnedSource(state.metadata.sourceManifest, { sourceId, path, receiverId: dispatch.runtimePluginId });
  assert(pinned.bytes.length <= 512 * 1024, 'SOURCE_READ_BUDGET', 'Pinned source read exceeds 512 KiB; use source search or a narrower file.');
  return { sourceId, path, contentDigest: pinned.contentDigest, revision: pinned.revision, manifestDigest: pinned.manifestDigest, text: pinned.bytes.toString('utf8') };
};

export const searchSourceForDispatch = async ({ authorityStore, projectId, runId, dispatchId, query, maxMatches = 50, readPinned = null }) => {
  assert(typeof query === 'string' && query.length >= 2 && query.length <= 256 && Number.isInteger(maxMatches) && maxMatches >= 1 && maxMatches <= 100, 'SOURCE_SEARCH_QUERY_INVALID', 'Source search requires a 2-256 character literal query and 1-100 matches.');
  const state = await authorityStore.read(projectId, runId);
  const dispatch = state.dispatches.find(item => item.dispatchId === dispatchId && ['requested', 'assigned'].includes(item.status));
  assert(dispatch, 'SOURCE_DISPATCH_INVALID', 'Pinned source search requires a live Dispatch.');
  const allowed = new Set(dispatch.featureSnapshot?.metadata?.sourceIds ?? []);
  const matches = [];
  for (const source of state.metadata.sourceManifest.sources) {
    if (!allowed.has(source.sourceId)) continue;
    for (const file of source.files) {
      const pinned = readPinned ? await readPinned({ projectId, runId, dispatchId, sourceId: source.sourceId, path: file.path }) : await readPinnedSource(state.metadata.sourceManifest, { sourceId: source.sourceId, path: file.path, receiverId: dispatch.runtimePluginId });
      if (pinned.bytes.length > 2 * 1024 * 1024) continue;
      const lines = pinned.bytes.toString('utf8').split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) if (lines[index].toLowerCase().includes(query.toLowerCase())) {
        matches.push({ sourceId: source.sourceId, path: file.path, line: index + 1, text: lines[index].slice(0, 500), contentDigest: file.sha256 });
        if (matches.length >= maxMatches) return { manifestDigest: state.metadata.sourceManifest.manifestDigest, matches, truncated: true };
      }
    }
  }
  return { manifestDigest: state.metadata.sourceManifest.manifestDigest, matches, truncated: false };
};
