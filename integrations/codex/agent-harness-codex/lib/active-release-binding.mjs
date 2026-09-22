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

const validateDevelopmentBinding = async ({ controlRoot, dataRoot, entrypoint, declaredRelease, verifyAllFiles }) => {
  const manifestFile = resolve(declaredRelease?.developmentManifest ?? '');
  if (declaredRelease?.mode !== 'source-link' || !isAbsolute(declaredRelease.developmentManifest ?? '') || !inside(dataRoot, manifestFile)) throw new Error('source-link 绑定必须声明 dataRoot 内的 developmentManifest。');
  const manifest = await readJson(manifestFile);
  const unsigned = structuredClone(manifest);
  delete unsigned.manifestDigest;
  if (manifest?.protocolVersion !== '1.0' || manifest.kind !== 'development-source-manifest' || manifest.manifestDigest !== digestJson(unsigned) || !Array.isArray(manifest.files) || !manifest.files.length || !Array.isArray(manifest.sourceIdentity?.runtimeFiles) || !manifest.sourceIdentity.runtimeFiles.length) throw new Error(`development source manifest 无效：${manifestFile}`);
  if (!samePath(manifest.sourceRoot, controlRoot) || !samePath(manifest.controlRoot, controlRoot) || !samePath(manifest.dataRoot, dataRoot) || !samePath(manifest.entrypoint, entrypoint)) throw new Error('source-link 绑定根目录或 entrypoint 与 development manifest 不一致。');
  if (declaredRelease.version !== manifest.release?.version || declaredRelease.artifactDigest !== manifest.release?.artifactDigest) throw new Error('source-link release identity 已过期；请重新执行 dev rebind。');
  if (manifest.release?.mode !== 'source-link' || manifest.release.artifactDigest !== digestJson(manifest.sourceIdentity.runtimeFiles) || manifest.release.artifactDigest !== manifest.sourceIdentity.runtimeDigest) throw new Error('development source 运行时文件清单摘要无效。');
  const seen = new Set();
  for (const item of manifest.files) {
    const file = resolve(controlRoot, item?.path ?? '');
    if (typeof item?.path !== 'string' || !item.path || isAbsolute(item.path) || !inside(controlRoot, file) || seen.has(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '') || !Number.isInteger(item.size) || item.size < 0) throw new Error(`development source 文件记录无效：${item?.path ?? '<unknown>'}`);
    seen.add(item.path);
  }
  const runtimePaths = new Set();
  for (const item of manifest.sourceIdentity.runtimeFiles) {
    const declared = manifest.files.find(candidate => candidate.path === item?.path);
    if (!declared || declared.sha256 !== item.sha256 || declared.size !== item.size || runtimePaths.has(item.path)) throw new Error(`development source 运行时文件记录无效：${item?.path ?? '<unknown>'}`);
    runtimePaths.add(item.path);
  }
  if (manifest.sourceIdentity.supportFiles !== undefined) {
    const supportPaths = new Set();
    for (const item of manifest.sourceIdentity.supportFiles) {
      const declared = manifest.files.find(candidate => candidate.path === item?.path);
      if (!declared || declared.sha256 !== item.sha256 || declared.size !== item.size || runtimePaths.has(item.path) || supportPaths.has(item.path)) throw new Error(`development source 支持文件记录无效：${item?.path ?? '<unknown>'}`);
      supportPaths.add(item.path);
    }
    if (runtimePaths.size + supportPaths.size !== manifest.files.length) throw new Error('development source 文件分组未完整覆盖 manifest。');
  }
  const requiredPaths = [relative(controlRoot, entrypoint).replaceAll('\\', '/'), relative(controlRoot, manifest.channels?.codex?.coordinatorEntrypoint ?? '').replaceAll('\\', '/'), relative(controlRoot, manifest.channels?.codex?.hostBridgeModule ?? '').replaceAll('\\', '/')];
  if (!requiredPaths.every(path => seen.has(path))) throw new Error('development source manifest 未覆盖 CLI、Coordinator 或 Host bridge。');
  const targets = verifyAllFiles ? manifest.files : manifest.sourceIdentity.runtimeFiles;
  for (const item of targets) {
    const bytes = await readFile(resolve(controlRoot, item.path));
    if (bytes.length !== item.size || sha256(bytes) !== item.sha256) throw Object.assign(new Error(`Harness source 已变化：${item.path}；请执行 dev rebind。`), { code: 'HARNESS_SOURCE_IDENTITY_CHANGED' });
  }
  return Object.freeze({
    mode: 'source-link', version: manifest.release.version, artifactDigest: manifest.release.artifactDigest,
    channelArtifactDigest: manifest.release.artifactDigest, compositionDigest: null, generationId: `dev-${manifest.bindingId}`,
    pointerDigest: manifest.manifestDigest, runtimeRoot: controlRoot, registryRoot: resolve(dataRoot, 'registry'), entrypoint,
    coordinatorEntrypoint: resolve(manifest.channels.codex.coordinatorEntrypoint), hostBridgeModule: resolve(manifest.channels.codex.hostBridgeModule), developmentManifest: manifestFile,
  });
};

export const validateActiveReleaseBinding = async ({ controlRoot: controlRootInput, dataRoot: dataRootInput, entrypoint: entrypointInput, declaredRelease = null, verifyAllFiles = false }) => {
  const controlRoot = resolve(controlRootInput);
  const dataRoot = resolve(dataRootInput);
  const entrypoint = resolve(entrypointInput);
  if (!inside(controlRoot, dataRoot) || !inside(controlRoot, entrypoint)) throw new Error('dataRoot 和 entrypoint 必须位于 controlRoot 内。');
  if (declaredRelease?.mode === 'source-link') return validateDevelopmentBinding({ controlRoot, dataRoot, entrypoint, declaredRelease, verifyAllFiles });
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
  const channelManifestFile = resolve(runtimeRoot, 'codex-channel-manifest.json');
  const channel = await readJson(channelManifestFile);
  const { artifactDigest: channelArtifactDigest, ...channelBody } = channel;
  if (channel.protocolVersion !== '1.0' || channel.channel !== 'codex' || !Array.isArray(channel.files) || channelArtifactDigest !== digestJson(channelBody) || channel.contentDigest !== digestJson(channel.files) || channel.requiresCore?.packageDigest !== manifest.packageDigest || channel.requiresCore?.version !== manifest.version || channel.layout?.pluginPath !== 'integrations/codex/agent-harness-codex') throw new Error('Codex 渠道清单与 active Core runtime 不匹配。');
  if (declaredRelease && declaredRelease.channelArtifactDigest !== channelArtifactDigest) throw new Error('绑定 Codex 渠道 identity 已过期；必须按当前 active release 重新配置插件。');
  let compositionDigest = null;
  if (pointer.compositionDigest !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(pointer.compositionDigest) || !Array.isArray(pointer.channels) || pointer.channels.length === 0) throw new Error('active release composition identity 无效。');
    const declaredChannel = pointer.channels.find(item => item.id === 'codex');
    if (!declaredChannel || declaredChannel.version !== channel.plugin?.version || declaredChannel.artifactDigest !== channelArtifactDigest || declaredChannel.manifest !== 'codex-channel-manifest.json') throw new Error('active release Codex channel identity 与 Runtime 不匹配。');
    const composition = await readJson(resolve(runtimeRoot, 'runtime-composition.json'));
    const unsignedComposition = structuredClone(composition);
    delete unsignedComposition.compositionDigest;
    if (composition?.protocolVersion !== '1.0' || composition.kind !== 'runtime-composition' || composition.compositionDigest !== digestJson(unsignedComposition) || composition.compositionDigest !== pointer.compositionDigest || composition.core?.version !== manifest.version || composition.core?.artifactDigest !== manifest.packageDigest || digestJson(composition.channels) !== digestJson(pointer.channels) || composition.runtimeEntrypoint !== entryRelative) throw new Error('active release Runtime composition manifest 无效。');
    compositionDigest = composition.compositionDigest;
    if (declaredRelease && declaredRelease.compositionDigest !== compositionDigest) throw new Error('绑定 Runtime composition identity 已过期；必须按当前 active release 重新配置插件。');
  } else if (declaredRelease?.compositionDigest !== undefined) throw new Error('绑定声明了不存在的 Runtime composition identity。');
  const coordinatorRelative = 'integrations/codex/agent-harness-codex/scripts/visible-lifecycle-coordinator.mjs';
  const coordinatorEntrypoint = resolve(runtimeRoot, coordinatorRelative);
  const hostBridgeRelative = 'integrations/codex/agent-harness-codex/lib/hook-host-exchange.mjs';
  const hostBridgeModule = resolve(runtimeRoot, hostBridgeRelative);
  if (!channel.files.some(item => item.path === coordinatorRelative)) throw new Error('Codex 渠道清单未包含 visible lifecycle Coordinator。');
  if (!channel.files.some(item => item.path === hostBridgeRelative)) throw new Error('Codex 渠道清单未包含 PostToolUse Host bridge。');
  const channelPaths = new Set();
  for (const item of channel.files) {
    const file = resolve(runtimeRoot, item?.path ?? '');
    if (typeof item?.path !== 'string' || !item.path || isAbsolute(item.path) || !inside(runtimeRoot, file) || channelPaths.has(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '') || !Number.isInteger(item.size) || item.size < 0 || !(item.path.startsWith('integrations/codex/agent-harness-codex/') || item.path === '.agents/plugins/marketplace.json')) throw new Error(`Codex 渠道清单文件记录无效：${item?.path ?? '<unknown>'}`);
    channelPaths.add(item.path);
  }
  const targets = verifyAllFiles ? manifest.files : [entryRecord];
  for (const item of targets) {
    const bytes = await readFile(resolve(runtimeRoot, item.path));
    if (bytes.length !== item.size || sha256(bytes) !== item.sha256) throw new Error(`active runtime 文件与 release manifest 不一致：${item.path}`);
  }
  for (const item of channel.files) {
    const bytes = await readFile(resolve(runtimeRoot, item.path));
    if (bytes.length !== item.size || sha256(bytes) !== item.sha256) throw new Error(`Codex 渠道文件与清单不一致：${item.path}`);
  }
  const registryRoot = resolve(dataRoot, 'registry', 'generations', pointer.generationId);
  if (!(await optionalLstat(resolve(registryRoot, 'extensions.json')))?.isFile() || !(await optionalLstat(resolve(registryRoot, 'projects')))?.isDirectory()) throw new Error(`active Registry generation 不完整：${registryRoot}`);
  return Object.freeze({ version: manifest.version, artifactDigest: manifest.packageDigest, channelArtifactDigest, compositionDigest, generationId: pointer.generationId, pointerDigest: pointer.pointerDigest, runtimeRoot, registryRoot, entrypoint: activeEntrypoint, coordinatorEntrypoint, hostBridgeModule });
};
