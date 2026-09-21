import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  createPluginMutationPlan,
  inspectMarketplaceConfiguration,
  inspectCodexHostFeatures,
  inspectPluginInstallation,
  probeInstalledPostToolHook,
  runLocalPluginRelease,
  validateLocalReleaseConfiguration,
  validatePluginBindings,
  verifyLocalPluginPreparationReceipt,
} from '../scripts/plugin-release-workflow.mjs';
import { digestJson } from '../src/common/canonical.mjs';

const root = resolve('.');
const pluginRoot = resolve(root, 'integrations/codex/agent-harness-codex');
const packageJson = { name: 'agent-harness', version: '1.0.0' };
const packageLock = { packages: { '': { version: '1.0.0' } } };
const pluginManifest = { name: 'agent-harness-codex', version: '1.0.0' };
const marketplace = {
  name: 'agent-harness-local',
  plugins: [{ name: 'agent-harness-codex', source: { source: 'local', path: './integrations/codex/agent-harness-codex' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } }],
};
const sourcePackageDigest = JSON.parse(readFileSync(resolve(root, 'release-manifest.json'), 'utf8')).packageDigest;
const codexArtifactDigest = 'f'.repeat(64);
const codexFeatures = 'multi_agent                              stable             true\nmulti_agent_v2                           stable             true\n';

const config = () => validateLocalReleaseConfiguration({ root, packageJson, packageLock, pluginManifest, marketplace });
const installedPlugin = current => ({
  pluginId: current.pluginId,
  name: current.pluginName,
  marketplaceName: current.marketplaceName,
  version: current.version,
  installed: true,
  enabled: true,
  installPolicy: 'AVAILABLE',
  authPolicy: 'ON_INSTALL',
  source: { source: 'local', path: current.pluginRoot },
});
const bindingState = current => ({
  bindingFile: resolve(current.pluginRoot, '.plugin-data', 'bindings.json'),
  digest: 'c'.repeat(64),
  controlRoot: root,
  entrypoint: resolve(root, 'bin/agent-harness.mjs'),
  dataRoot: resolve(root, '.agent-harness-data'),
  release: { version: '1.0.0', packageDigest: sourcePackageDigest, channelArtifactDigest: codexArtifactDigest, generationId: 'g-current', pointerDigest: 'd'.repeat(64), entrypoint: resolve(root, 'bin/agent-harness.mjs'), runtimeRoot: root, registryRoot: resolve(root, '.agent-harness-data', 'registry', 'generations', 'g-current') },
  projectAliases: ['engine'],
});

test('local plugin release configuration binds package, lock, plugin and marketplace exactly', () => {
  const value = config();
  assert.equal(value.pluginId, 'agent-harness-codex@agent-harness-local');
  assert.equal(value.version, '1.0.0');
  assert.equal(value.pluginRoot, pluginRoot);
  assert.throws(
    () => validateLocalReleaseConfiguration({ root, packageJson, packageLock, pluginManifest: { ...pluginManifest, version: '1.0.0+codex.cache' }, marketplace }),
    error => error?.code === 'LOCAL_RELEASE_VERSION_INVALID',
  );
  assert.throws(
    () => validateLocalReleaseConfiguration({ root, packageJson: { ...packageJson, version: '1.0.1' }, packageLock: { packages: { '': { version: '1.0.1' } } }, pluginManifest: { ...pluginManifest, version: '1.0.1' }, marketplace }),
    error => error?.code === 'LOCAL_RELEASE_VERSION_INVALID',
  );
  assert.throws(
    () => validateLocalReleaseConfiguration({ root, packageJson, packageLock, pluginManifest, marketplace: { ...marketplace, plugins: [{ ...marketplace.plugins[0], policy: { installation: 'AVAILABLE', authentication: 'NONE' } }] } }),
    error => error?.code === 'LOCAL_RELEASE_MARKETPLACE_POLICY_MISMATCH',
  );
  assert.throws(
    () => validateLocalReleaseConfiguration({ root, packageJson, packageLock, pluginManifest, marketplace: { ...marketplace, plugins: [{ ...marketplace.plugins[0], source: { source: 'local', path: '../other-plugin' } }] } }),
    error => ['PATH_OUTSIDE_ROOT', 'LOCAL_RELEASE_MARKETPLACE_PATH_MISMATCH', 'LOCAL_RELEASE_MARKETPLACE_PATH_INVALID'].includes(error?.code),
  );
});

test('marketplace inspection rejects a same-name marketplace at another root', () => {
  assert.deepEqual(inspectMarketplaceConfiguration({ payload: { marketplaces: [] }, marketplaceName: 'agent-harness-local', root }), { configured: false });
  assert.equal(inspectMarketplaceConfiguration({ payload: { marketplaces: [{ name: 'agent-harness-local', root: `\\\\?\\${root}` }] }, marketplaceName: 'agent-harness-local', root }).configured, true);
  assert.throws(
    () => inspectMarketplaceConfiguration({ payload: { marketplaces: [{ name: 'agent-harness-local', root: resolve(root, '..', 'other') }] }, marketplaceName: 'agent-harness-local', root }),
    error => error?.code === 'LOCAL_RELEASE_MARKETPLACE_ROOT_MISMATCH',
  );
});

test('installed plugin inspection binds source and verifies final version and enabled state', () => {
  const current = config();
  const installed = installedPlugin(current);
  const payload = { installed: [installed], available: [] };
  assert.equal(inspectPluginInstallation({ payload, config: current, requireInstalled: true }).installed, true);
  assert.throws(
    () => inspectPluginInstallation({ payload: { installed: [{ ...installed, source: { source: 'local', path: resolve(root, '..', 'other') } }], available: [] }, config: current }),
    error => error?.code === 'LOCAL_RELEASE_PLUGIN_SOURCE_MISMATCH',
  );
  assert.throws(
    () => inspectPluginInstallation({ payload: { installed: [{ ...installed, enabled: false }], available: [] }, config: current, requireInstalled: true }),
    error => error?.code === 'LOCAL_RELEASE_PLUGIN_INACTIVE',
  );
});

test('Codex host feature inspection requires native Multi-Agent V2', () => {
  assert.deepEqual(inspectCodexHostFeatures(codexFeatures), { contract: 'multi-agent-v2', multiAgent: true, multiAgentV2: true });
  assert.throws(
    () => inspectCodexHostFeatures('multi_agent stable true\nmulti_agent_v2 stable false\n'),
    error => error?.code === 'LOCAL_RELEASE_MULTI_AGENT_V2_REQUIRED',
  );
  assert.throws(
    () => inspectCodexHostFeatures('multi_agent stable false\nmulti_agent_v2 stable true\n'),
    error => error?.code === 'LOCAL_RELEASE_MULTI_AGENT_DISABLED',
  );
});

test('mutation plan always adds and verifies, and clears cache before same-version reinstall', () => {
  const current = config();
  assert.deepEqual(
    createPluginMutationPlan({ marketplaceConfigured: true, pluginInstalled: true, config: current }).map(step => step.id),
    ['plugin-remove', 'plugin-add', 'plugin-verify'],
  );
  assert.deepEqual(
    createPluginMutationPlan({ marketplaceConfigured: false, pluginInstalled: false, config: current }).map(step => step.id),
    ['marketplace-add', 'plugin-add', 'plugin-verify'],
  );
  assert.doesNotMatch(JSON.stringify(createPluginMutationPlan({ marketplaceConfigured: true, pluginInstalled: true, config: current })), /codex[\\\s\",]+exec/i);
});

test('preparation receipt seals the exact Core, Codex, and candidate artifact identities', () => {
  const body = {
    protocolVersion: '1.0',
    kind: 'local-plugin-release-preparation-receipt',
    workflowVersion: '1.0',
    status: 'prepared',
    source: { commit: 'a'.repeat(40), clean: true },
    release: { version: '1.0.0', packageDigest: 'b'.repeat(64) },
    channelPackages: {
      core: { channel: 'core', identity: 'b'.repeat(64), packageDigest: 'b'.repeat(64), archiveDigest: 'c'.repeat(64), archive: 'core.tgz', receipt: 'core.json' },
      codex: { channel: 'codex', identity: 'd'.repeat(64), artifactDigest: 'd'.repeat(64), requiredCorePackageDigest: 'b'.repeat(64), archiveDigest: 'e'.repeat(64), archive: 'codex.tgz', receipt: 'codex.json' },
    },
    candidate: { ok: true, packageDigest: 'b'.repeat(64), archiveDigest: 'f'.repeat(64), archive: 'candidate.tgz', receipt: 'candidate.json' },
    steps: ['check:codex-host-fast', 'check', 'test', 'workspace:canary', 'check:clean-room', 'pack:core', 'pack:codex', 'check:residue', 'check:channel-composition', 'build:release-candidate'].map(id => ({ id, status: 'passed' })),
    startedAt: '2026-09-21T00:00:00.000Z',
    completedAt: '2026-09-21T00:01:00.000Z',
  };
  const receipt = { ...body, receiptDigest: digestJson(body) };
  assert.equal(verifyLocalPluginPreparationReceipt(receipt).receiptDigest, receipt.receiptDigest);
  assert.throws(
    () => verifyLocalPluginPreparationReceipt({ ...receipt, status: 'failed' }),
    error => error?.code === 'LOCAL_RELEASE_PREPARATION_INVALID',
  );
  assert.throws(
    () => verifyLocalPluginPreparationReceipt({ ...receipt, release: { ...receipt.release, packageDigest: '0'.repeat(64) } }),
    error => error?.code === 'LOCAL_RELEASE_PREPARATION_DIGEST_MISMATCH',
  );
});

test('installed Hook probe is bounded and invokes the exact cached PostToolUse entrypoint', async t => {
  const fixture = await mkdtemp(resolve(tmpdir(), 'agent-harness-installed-hook-probe-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const pluginRoot = resolve(fixture, 'plugin');
  const pluginData = resolve(pluginRoot, '.plugin-data');
  await mkdir(resolve(pluginRoot, 'hooks'), { recursive: true });
  await mkdir(pluginData, { recursive: true });
  const bindingFile = resolve(pluginData, 'bindings.json');
  await writeFile(bindingFile, '{}\n');
  await writeFile(resolve(pluginRoot, 'hooks', 'post-tool-host-bridge.mjs'), "let raw = ''; for await (const chunk of process.stdin) raw += chunk; const event = JSON.parse(raw); if (event.tool_name !== 'collaboration.list_agents') process.exitCode = 2; else process.stdout.write('{}');\n");
  const result = await probeInstalledPostToolHook({ root, installedBindings: { bindingFile }, timeoutMs: 1000 });
  assert.match(result.probeDigest, /^[a-f0-9]{64}$/);
  assert.equal(result.hook, resolve(pluginRoot, 'hooks', 'post-tool-host-bridge.mjs'));
});

test('plugin bindings pin this control root, an existing entrypoint and absolute project workspaces', async () => {
  const current = config();
  const bindings = {
    protocolVersion: '1.0',
    harness: { controlRoot: root, entrypoint: resolve(root, 'bin/agent-harness.mjs'), dataRoot: resolve(root, '.agent-harness-data'), release: { version: '1.0.0', artifactDigest: sourcePackageDigest, channelArtifactDigest: codexArtifactDigest, generationId: 'g-current', pointerDigest: 'd'.repeat(64) } },
    projects: { engine: { projectId: 'engine', profileId: 'engine-delivery', extensionId: 'engine-extension', workspaceRoot: resolve(root, 'fixture-workspace') } },
  };
  const activeReleaseLoader = async () => ({ version: '1.0.0', packageDigest: sourcePackageDigest, channelArtifactDigest: codexArtifactDigest, generationId: 'g-current', pointerDigest: 'd'.repeat(64), entrypoint: resolve(root, 'bin/agent-harness.mjs'), runtimeRoot: root, registryRoot: resolve(root, '.agent-harness-data', 'registry', 'generations', 'g-current') });
  const validated = await validatePluginBindings({ root, config: current, bindings, activeReleaseLoader });
  assert.equal(validated.entrypoint, resolve(root, 'bin/agent-harness.mjs'));
  assert.deepEqual(validated.projectAliases, ['engine']);
  await assert.rejects(
    () => validatePluginBindings({ root, config: current, bindings: { ...bindings, harness: { ...bindings.harness, release: { ...bindings.harness.release, generationId: 'g-stale' } } }, activeReleaseLoader }),
    error => error?.code === 'LOCAL_RELEASE_BINDING_RELEASE_STALE',
  );
  await assert.rejects(
    () => validatePluginBindings({ root, config: current, bindings: { ...bindings, harness: { ...bindings.harness, controlRoot: resolve(root, '..', 'other') } }, activeReleaseLoader }),
    error => error?.code === 'LOCAL_RELEASE_BINDING_CONTROL_ROOT_MISMATCH',
  );
});

test('release workflow rejects a plugin binding whose active runtime digest is stale', async () => {
  const current = config();
  const commit = 'e'.repeat(40);
  const runner = async (executable, args) => {
    if (executable === 'git' && args.join(' ') === 'rev-parse --show-toplevel') return { stdout: `${root}\n` };
    if (executable === 'git' && args.join(' ') === 'rev-parse HEAD') return { stdout: `${commit}\n` };
    if (executable === 'git' && args[0] === 'status') return { stdout: '' };
    throw new Error(`Unexpected command: ${executable} ${args.join(' ')}`);
  };
  await assert.rejects(
    () => runLocalPluginRelease({ root, mode: 'check', npmCli: 'npm-cli.js', runner, bindingsLoader: async () => ({ ...bindingState(current), release: { ...bindingState(current).release, packageDigest: '0'.repeat(64) } }) }),
    error => error?.code === 'LOCAL_RELEASE_ACTIVE_RUNTIME_STALE',
  );
});

test('apply mode refuses to rebuild or install without a sealed preparation receipt', async () => {
  const commit = '9'.repeat(40);
  const runner = async (executable, args) => {
    if (executable === 'git' && args.join(' ') === 'rev-parse --show-toplevel') return { stdout: `${root}\n` };
    if (executable === 'git' && args.join(' ') === 'rev-parse HEAD') return { stdout: `${commit}\n` };
    if (executable === 'git' && args[0] === 'status') return { stdout: '' };
    throw new Error(`Unexpected command: ${executable} ${args.join(' ')}`);
  };
  await assert.rejects(
    () => runLocalPluginRelease({ root, mode: 'apply', npmCli: 'npm-cli.js', runner }),
    error => error?.code === 'LOCAL_RELEASE_PREPARATION_REQUIRED',
  );
});

test('check mode verifies a clean commit and installed local plugin without running build or mutation commands', async () => {
  const current = config();
  const commit = 'a'.repeat(40);
  const calls = [];
  const runner = async (executable, args) => {
    calls.push([executable, ...args]);
    if (executable === 'git' && args.join(' ') === 'rev-parse --show-toplevel') return { stdout: `${root}\n` };
    if (executable === 'git' && args.join(' ') === 'rev-parse HEAD') return { stdout: `${commit}\n` };
    if (executable === 'git' && args[0] === 'status') return { stdout: '' };
    if (executable === 'codex' && args.join(' ') === 'features list') return { stdout: codexFeatures };
    if (executable === 'codex' && args[1] === 'marketplace') return { json: { marketplaces: [{ name: current.marketplaceName, root }] } };
    if (executable === 'codex' && args[1] === 'list') return { json: { installed: [installedPlugin(current)], available: [] } };
    throw new Error(`Unexpected command: ${executable} ${args.join(' ')}`);
  };

  const result = await runLocalPluginRelease({ root, mode: 'check', npmCli: 'npm-cli.js', runner, bindingsLoader: async () => bindingState(current), installedBindingsLoader: async () => bindingState(current) });
  assert.equal(result.ok, true);
  assert.equal(result.source.commit, commit);
  assert.deepEqual(result.mutationPlan.map(step => step.id), ['plugin-remove', 'plugin-add', 'plugin-verify']);
  assert.equal(calls.some(call => call.includes('remove') || call.includes('add') || call.includes('run')), false);
});

test('check mode rejects a stale installed-cache binding even when plugin metadata looks current', async () => {
  const current = config();
  const commit = 'f'.repeat(40);
  const runner = async (executable, args) => {
    if (executable === 'git' && args.join(' ') === 'rev-parse --show-toplevel') return { stdout: `${root}\n` };
    if (executable === 'git' && args.join(' ') === 'rev-parse HEAD') return { stdout: `${commit}\n` };
    if (executable === 'git' && args[0] === 'status') return { stdout: '' };
    if (executable === 'codex' && args.join(' ') === 'features list') return { stdout: codexFeatures };
    if (executable === 'codex' && args[1] === 'marketplace') return { json: { marketplaces: [{ name: current.marketplaceName, root }] } };
    if (executable === 'codex' && args[1] === 'list') return { json: { installed: [installedPlugin(current)], available: [] } };
    throw new Error(`Unexpected command: ${executable} ${args.join(' ')}`);
  };
  await assert.rejects(
    () => runLocalPluginRelease({ root, mode: 'check', npmCli: 'npm-cli.js', runner, bindingsLoader: async () => bindingState(current), installedBindingsLoader: async () => ({ ...bindingState(current), digest: '0'.repeat(64), bindingFile: 'installed-bindings.json' }) }),
    error => error?.code === 'LOCAL_RELEASE_INSTALLED_BINDINGS_STALE',
  );
});

test('check mode rejects a dirty tree before reading or changing Codex plugin state', async () => {
  const commit = 'b'.repeat(40);
  const calls = [];
  const runner = async (executable, args) => {
    calls.push([executable, ...args]);
    if (args.join(' ') === 'rev-parse --show-toplevel') return { stdout: `${root}\n` };
    if (args.join(' ') === 'rev-parse HEAD') return { stdout: `${commit}\n` };
    if (args[0] === 'status') return { stdout: ' M package.json\n' };
    throw new Error(`Unexpected command: ${executable} ${args.join(' ')}`);
  };

  await assert.rejects(
    () => runLocalPluginRelease({ root, mode: 'check', npmCli: 'npm-cli.js', runner }),
    error => error?.code === 'LOCAL_RELEASE_SOURCE_DIRTY',
  );
  assert.equal(calls.every(call => call[0] === 'git'), true);
});
