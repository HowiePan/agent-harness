import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { safeSegment } from '../common/paths.mjs';
import { readJson } from '../kernel/atomic-io.mjs';
import { digestJson } from '../common/canonical.mjs';
import { assert, fail } from '../common/errors.mjs';

// Command intents may embed complete revision plans; indexes need identity only.
export const historyCommandIdentity = value => value && Object.fromEntries(
  ['action','target','workflowId','preset','selector'].filter(key=>value[key]!==undefined).map(key=>[key,value[key]]));

/** Same persisted Authority digest check without cloning the complete record
 * just to omit its top-level digest field. Never writes or accepts a projection. */
export const readVerifiedRunRecord = async (store, projectId, runId, { required = true } = {}) => {
  if (!store.runFile) return store.read(projectId, runId, { required });
  const state = await readJson(store.runFile(projectId, runId), null);
  if (!state && required) fail('RUN_NOT_FOUND', `Run not found: ${projectId}/${runId}`);
  if (state) {
    const { authorityDigest, ...body } = state;
    assert(authorityDigest === digestJson(body), 'AUTHORITY_DIGEST_MISMATCH',
      'Authority digest does not match persisted state.', { projectId, runId });
  }
  return state;
};

/** Preserve every verified value; share only identical immutable string bytes.
 * Full history remains available without retaining repeated large contracts and
 * prompts in a separate string allocation for each archived Run. */
export const readVerifiedRunHistory = async (store, projectId, { include = () => true } = {}) => {
  const strings = new Map();
  const intern = value => {
    if (typeof value === 'string' && value.length >= 128) {
      if (!strings.has(value)) strings.set(value, value);
      return strings.get(value);
    }
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) value[key] = intern(value[key]);
    }
    return value;
  };
  if (!store.root || !store.runFile) return (await store.list(projectId)).filter(include).map(intern);
  const path = resolve(store.root, 'authority', safeSegment(projectId, 'projectId'));
  let entries;
  try { entries = await readdir(path, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const states = [];
  for (const entry of entries.filter(item => item.isDirectory())) {
    const state = await readVerifiedRunRecord(store, projectId, entry.name, { required: false });
    if (state && include(state)) states.push(intern(state));
  }
  return states.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
};
