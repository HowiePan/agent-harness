import { mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digestJson } from '../common/canonical.mjs';
import { assert } from '../common/errors.mjs';
import { atomicWriteJson, readJson } from './atomic-io.mjs';
import { assertHarnessWritePath } from '../common/write-boundary.mjs';

export const gateCacheKey = input => digestJson({ gateId: input.gateId, specDigest: input.specDigest, sourceDigest: input.sourceDigest, artifactDigest: input.artifactDigest ?? null, policyDigest: input.policyDigest ?? null, toolchainDigest: input.toolchainDigest, lockDigest: input.lockDigest ?? null, environmentDigest: input.environmentDigest, pluginDigest: input.pluginDigest });

export class GateCache {
  constructor({ root, controlRoot, now = () => new Date().toISOString() }) { this.root = assertHarnessWritePath(root, 'Gate cache root', controlRoot); this.directory = resolve(this.root, 'cache', 'gates'); this.now = now; }
  file(key) { return resolve(this.directory, `${key}.json`); }
  async get(input, { forceFresh = false } = {}) {
    const key = gateCacheKey(input);
    if (forceFresh) return { hit: false, forcedFresh: true, key };
    const value = await readJson(this.file(key), null);
    if (!value) return { hit: false, forcedFresh: false, key };
    assert(value.key === key && value.status === 'passed', 'GATE_CACHE_INVALID', 'Gate cache contains a non-reusable entry.');
    return { hit: true, forcedFresh: false, key, value };
  }
  async put(input, result) {
    assert(result.status === 'passed', 'GATE_CACHE_SUCCESS_ONLY', 'Only passed Gate results may be cached.');
    const key = gateCacheKey(input);
    await mkdir(this.directory, { recursive: true });
    const value = { protocolVersion: '1.0', key, ...structuredClone(input), result: structuredClone(result), status: 'passed', cachedAt: this.now() };
    await atomicWriteJson(this.file(key), value, { root: this.root });
    return value;
  }
  async metrics() {
    try { return { entries: (await readdir(this.directory)).filter(name => name.endsWith('.json')).length }; }
    catch (error) { if (error.code === 'ENOENT') return { entries: 0 }; throw error; }
  }
}
