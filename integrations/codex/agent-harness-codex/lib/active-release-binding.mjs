import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import process from 'node:process';

const inside = (parent, child) => {
  const path = relative(resolve(parent), resolve(child));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
};

const samePath = (left, right) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
  : resolve(left) === resolve(right);

const normalize = value => {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
  throw new Error(`canonical JSON 不支持 ${typeof value}`);
};

const digestJson = value => createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const optionalLstat = async path => {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

export const validateActiveReleaseBinding = async ({ controlRoot: controlRootInput, dataRoot: dataRootInput, entrypoint: entrypointInput, declaredRelease = null, verifyAllFiles = false }) => {
  const controlRoot = resolve(controlRootInput);
  const dataRoot = resolve(dataRootInput);
  const entrypoint = resolve(entrypointInput);
  if (!inside(controlRoot, dataRoot) || !inside(controlRoot, entrypoint)) throw new Error('dataRoot 和 entrypoint 必须位于 controlRoot 内。');
  const pointerFile = resolve(dataRoot, 'registry', 'active-release.json');
  const pointer = await readJson(pointerFile);
  if (pointer?.protocolVersion !== '1.0' || pointer.kind !== 'active-release' || !pointer.generationId || !pointer.runtimeRoot || !pointer.runtimeEntrypoint || isAbsolute(pointer.runtimeRoot) || isAbsolute(pointer.runtimeEntrypoint)) throw new Error(`active release pointer 无效：${pointerFile}`);
  const unsigned = structuredClone(pointer);
  delete unsigned.pointerDigest;
  if (pointer.pointerDigest !== digestJson(unsigned)) throw new Error(`active release pointer 摘要不匹配：${pointerFile}`);
  const runtimeRoot = resolve(controlRoot, pointer.runtimeRoot);
  const activeEntrypoint = resolve(controlRoot, pointer.runtimeEntrypoint);
  if (!inside(controlRoot, runtimeRoot) || !inside(runtimeRoot, activeEntrypoint) || !samePath(entrypoint, activeEntrypoint)) throw new Error('绑定 entrypoint 不是 active release 的精确 runtimeEntrypoint。');
  if (declaredRelease && (declaredRelease.version !== pointer.release?.version || declaredRelease.artifactDigest !== pointer.release?.artifactDigest || declaredRelease.generationId !== pointer.generationId || declaredRelease.pointerDigest !== pointer.pointerDigest)) throw new Error('绑定 release identity 已过期；必须按当前 active release 重新配置插件。');
  const manifestFile = resolve(runtimeRoot, 'release-manifest.json');
  const manifest = await readJson(manifestFile);
  if (manifest?.protocolVersion !== '1.0' || !Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.packageDigest !== digestJson(manifest.files) || manifest.version !== pointer.release?.version || manifest.packageDigest !== pointer.release?.artifactDigest || pointer.release?.verified !== true) throw new Error('active runtime release manifest 与 release pointer 不一致。');
  const seen = new Set();
  for (const item of manifest.files) {
    const file = resolve(runtimeRoot, item?.path ?? '');
    if (typeof item?.path !== 'string' || !item.path || isAbsolute(item.path) || !inside(runtimeRoot, file) || seen.has(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '') || !Number.isInteger(item.size) || item.size < 0) throw new Error(`active runtime manifest 文件记录无效：${item?.path ?? '<unknown>'}`);
    seen.add(item.path);
  }
  const entryRelative = relative(runtimeRoot, activeEntrypoint).replaceAll('\\', '/');
  const entryRecord = manifest.files.find(item => item.path === entryRelative);
  if (!entryRecord) throw new Error('active runtime entrypoint 未纳入 release manifest。');
  const targets = verifyAllFiles ? manifest.files : [entryRecord];
  for (const item of targets) {
    const bytes = await readFile(resolve(runtimeRoot, item.path));
    if (bytes.length !== item.size || sha256(bytes) !== item.sha256) throw new Error(`active runtime 文件与 release manifest 不一致：${item.path}`);
  }
  const registryRoot = resolve(dataRoot, 'registry', 'generations', pointer.generationId);
  if (!(await optionalLstat(resolve(registryRoot, 'extensions.json')))?.isFile() || !(await optionalLstat(resolve(registryRoot, 'projects')))?.isDirectory()) throw new Error(`active Registry generation 不完整：${registryRoot}`);
  return Object.freeze({ version: manifest.version, artifactDigest: manifest.packageDigest, generationId: pointer.generationId, pointerDigest: pointer.pointerDigest, runtimeRoot, registryRoot, entrypoint: activeEntrypoint });
};
