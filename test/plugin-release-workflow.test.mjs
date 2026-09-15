import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import {
  createPluginMutationPlan,
  inspectMarketplaceConfiguration,
  inspectPluginInstallation,
  runLocalPluginRelease,
  validateLocalReleaseConfiguration,
  validatePluginBindings,
} from '../scripts/plugin-release-workflow.mjs';

const root = resolve('.');
const pluginRoot = resolve(root, 'integrations/codex/agent-harness-codex');
const packageJson = { name: 'agent-harness', version: '1.0.0' };
const packageLock = { packages: { '': { version: '1.0.0' } } };
const pluginManifest = { name: 'agent-harness-codex', version: '1.0.0' };
const marketplace = {
  name: 'agent-harness-local',
  plugins: [{ name: 'agent-harness-codex', source: { source: 'local', path: './integrations/codex/agent-harness-codex' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } }],
};

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

test('plugin bindings pin this control root, an existing entrypoint and absolute project workspaces', async () => {
  const current = config();
  const bindings = {
    protocolVersion: '1.0',
    harness: { controlRoot: root, entrypoint: resolve(root, 'bin/agent-harness.mjs'), dataRoot: resolve(root, '.agent-harness-data') },
    projects: { engine: { projectId: 'engine', profileId: 'engine-delivery', extensionId: 'engine-extension', workspaceRoot: resolve(root, 'fixture-workspace') } },
  };
  const validated = await validatePluginBindings({ root, config: current, bindings });
  assert.equal(validated.entrypoint, resolve(root, 'bin/agent-harness.mjs'));
  assert.deepEqual(validated.projectAliases, ['engine']);
  await assert.rejects(
    () => validatePluginBindings({ root, config: current, bindings: { ...bindings, harness: { ...bindings.harness, controlRoot: resolve(root, '..', 'other') } } }),
    error => error?.code === 'LOCAL_RELEASE_BINDING_CONTROL_ROOT_MISMATCH',
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
    if (executable === 'codex' && args[1] === 'marketplace') return { json: { marketplaces: [{ name: current.marketplaceName, root }] } };
    if (executable === 'codex' && args[1] === 'list') return { json: { installed: [installedPlugin(current)], available: [] } };
    throw new Error(`Unexpected command: ${executable} ${args.join(' ')}`);
  };

  const result = await runLocalPluginRelease({ root, mode: 'check', npmCli: 'npm-cli.js', runner, bindingsLoader: async () => bindingState(current) });
  assert.equal(result.ok, true);
  assert.equal(result.source.commit, commit);
  assert.deepEqual(result.mutationPlan.map(step => step.id), ['plugin-remove', 'plugin-add', 'plugin-verify']);
  assert.equal(calls.some(call => call.includes('remove') || call.includes('add') || call.includes('run')), false);
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
