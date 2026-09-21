import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { digestJson, sha256, withoutKeys } from '../../common/canonical.mjs';
import { assert } from '../../common/errors.mjs';
import { assertNoLinkPath } from '../../common/paths.mjs';
import { harnessControlRoot } from '../../common/write-boundary.mjs';
import { verifyReleaseManifest } from '../../application/release-identity.mjs';

const safeRelative = (value, code, message) => {
  assert(typeof value === 'string' && value.length > 0 && !isAbsolute(value) && !value.includes('\\') && !value.split('/').includes('..'), code, message);
  return value;
};

export const runtimeCompositionDigest = input => digestJson(withoutKeys(input, ['compositionDigest']));

export const createRuntimeCompositionManifest = ({ core, channels, runtimeEntrypoint = 'bin/agent-harness.mjs' }) => {
  assert(core?.verified === true && /^\d+\.\d+\.\d+$/.test(core.version ?? '') && /^[a-f0-9]{64}$/.test(core.artifactDigest ?? ''), 'RUNTIME_COMPOSITION_CORE_INVALID', 'Runtime composition requires a verified Core identity.');
  safeRelative(runtimeEntrypoint, 'RUNTIME_COMPOSITION_ENTRYPOINT_INVALID', 'Runtime composition entrypoint must be a safe relative path.');
  assert(Array.isArray(channels) && channels.length > 0, 'RUNTIME_COMPOSITION_CHANNELS_REQUIRED', 'Runtime composition requires at least one channel.');
  const normalizedChannels = channels.map(channel => {
    assert(/^[a-z][a-z0-9-]{0,31}$/.test(channel?.id ?? '') && /^\d+\.\d+\.\d+$/.test(channel?.version ?? '') && /^[a-f0-9]{64}$/.test(channel?.artifactDigest ?? ''), 'RUNTIME_COMPOSITION_CHANNEL_INVALID', 'Runtime composition channel identity is invalid.');
    return { id: channel.id, version: channel.version, artifactDigest: channel.artifactDigest, manifest: safeRelative(channel.manifest, 'RUNTIME_COMPOSITION_CHANNEL_MANIFEST_INVALID', 'Runtime composition channel manifest path is invalid.') };
  }).sort((left, right) => left.id.localeCompare(right.id));
  assert(new Set(normalizedChannels.map(channel => channel.id)).size === normalizedChannels.length, 'RUNTIME_COMPOSITION_CHANNEL_DUPLICATE', 'Runtime composition contains a duplicate channel.');
  const body = { protocolVersion: '1.0', kind: 'runtime-composition', core: { version: core.version, artifactDigest: core.artifactDigest, verified: true }, channels: normalizedChannels, runtimeEntrypoint };
  return Object.freeze({ ...body, compositionDigest: runtimeCompositionDigest(body) });
};

export const verifyRuntimeComposition = async ({ controlRoot: controlRootInput, runtimeRoot: runtimeRootInput, expectedDigest = undefined, expectedCore = undefined, expectedChannels = undefined }) => {
  const controlRoot = harnessControlRoot(controlRootInput);
  const runtimeRoot = assertNoLinkPath(controlRoot, resolve(runtimeRootInput), 'Runtime composition root');
  const rel = relative(controlRoot, runtimeRoot);
  assert(rel && !rel.startsWith('..') && !isAbsolute(rel), 'RUNTIME_COMPOSITION_ROOT_INVALID', 'Runtime composition root must stay inside the standalone control root.');
  const manifest = JSON.parse(await readFile(assertNoLinkPath(runtimeRoot, resolve(runtimeRoot, 'runtime-composition.json'), 'Runtime composition manifest'), 'utf8'));
  const normalized = createRuntimeCompositionManifest({ core: manifest.core, channels: manifest.channels, runtimeEntrypoint: manifest.runtimeEntrypoint });
  assert(manifest.compositionDigest === normalized.compositionDigest, 'RUNTIME_COMPOSITION_DIGEST_MISMATCH', 'Runtime composition digest does not match its contents.');
  if (expectedDigest !== undefined) assert(manifest.compositionDigest === expectedDigest, 'RUNTIME_COMPOSITION_IDENTITY_MISMATCH', 'Runtime composition does not match the expected digest.');
  if (expectedCore !== undefined) assert(manifest.core.version === expectedCore.version && manifest.core.artifactDigest === expectedCore.artifactDigest, 'RUNTIME_COMPOSITION_CORE_MISMATCH', 'Runtime composition does not match the expected Core identity.');
  const release = await verifyReleaseManifest({ root: runtimeRoot, artifactDigest: manifest.core.artifactDigest });
  assert(release.version === manifest.core.version, 'RUNTIME_COMPOSITION_CORE_MISMATCH', 'Runtime composition Core version does not match its release manifest.');
  await readFile(assertNoLinkPath(runtimeRoot, resolve(runtimeRoot, manifest.runtimeEntrypoint), 'Runtime composition entrypoint'));
  const verifiedChannels = [];
  for (const channel of manifest.channels) {
    const channelManifestFile = assertNoLinkPath(runtimeRoot, resolve(runtimeRoot, channel.manifest), `Runtime composition ${channel.id} manifest`);
    const channelManifest = JSON.parse(await readFile(channelManifestFile, 'utf8'));
    const { artifactDigest, ...body } = channelManifest;
    assert(channelManifest.protocolVersion === '1.0' && channelManifest.channel === channel.id && artifactDigest === digestJson(body) && artifactDigest === channel.artifactDigest && channelManifest.contentDigest === digestJson(channelManifest.files), 'RUNTIME_COMPOSITION_CHANNEL_MANIFEST_MISMATCH', `Runtime composition channel manifest is invalid: ${channel.id}`);
    assert(channelManifest.requiresCore?.version === manifest.core.version && channelManifest.requiresCore?.packageDigest === manifest.core.artifactDigest, 'RUNTIME_COMPOSITION_CHANNEL_CORE_MISMATCH', `Runtime composition channel requires another Core: ${channel.id}`);
    assert(channelManifest.plugin?.version === channel.version, 'RUNTIME_COMPOSITION_CHANNEL_VERSION_MISMATCH', `Runtime composition channel version is invalid: ${channel.id}`);
    const seen = new Set();
    for (const item of channelManifest.files) {
      safeRelative(item?.path, 'RUNTIME_COMPOSITION_CHANNEL_FILE_INVALID', `Runtime composition channel contains an invalid file: ${channel.id}`);
      assert(!seen.has(item.path) && /^[a-f0-9]{64}$/.test(item.sha256 ?? '') && Number.isInteger(item.size) && item.size >= 0, 'RUNTIME_COMPOSITION_CHANNEL_FILE_INVALID', `Runtime composition channel contains an invalid file: ${channel.id}`);
      seen.add(item.path);
      const bytes = await readFile(assertNoLinkPath(runtimeRoot, resolve(runtimeRoot, item.path), `Runtime composition ${channel.id} file`));
      assert(bytes.length === item.size && sha256(bytes) === item.sha256, 'RUNTIME_COMPOSITION_CHANNEL_FILE_MISMATCH', `Runtime composition channel file changed: ${item.path}`);
    }
    verifiedChannels.push({ id: channel.id, version: channel.version, artifactDigest: channel.artifactDigest, manifest: channel.manifest });
  }
  if (expectedChannels !== undefined) assert(digestJson(verifiedChannels) === digestJson(expectedChannels), 'RUNTIME_COMPOSITION_CHANNEL_SET_MISMATCH', 'Runtime composition channel set does not match the expected identities.');
  return Object.freeze({ ...normalized, runtimeRoot, entrypoint: resolve(runtimeRoot, normalized.runtimeEntrypoint) });
};
