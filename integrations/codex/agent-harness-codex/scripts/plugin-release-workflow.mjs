import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, relative, resolve } from 'node:path';
import { digestJson, sha256 } from '../../../../src/common/canonical.mjs';
import { assert } from '../../../../src/common/errors.mjs';
import { verifyReleaseCandidateReceipt } from '../../../../src/platform/maintenance/release-receipt.mjs';
import { assertNoLinkPath } from '../../../../src/common/paths.mjs';
import { verifyReleaseManifest } from '../../../../src/application/release-identity.mjs';
import { readActiveRelease, resolveActiveRegistryRoot, resolveActiveRuntimeRoot } from '../../../../src/platform/registry/active-generation.mjs';
import { assertHarnessWritePath } from '../../../../src/common/write-boundary.mjs';
import { parseLastJsonDocument } from '../../../../scripts/parse-json-output.mjs';
import { validateReleaseVersionContract } from '../../../../scripts/release-version-contract.mjs';
import { validateActiveReleaseBinding } from '../lib/active-release-binding.mjs';

export const LOCAL_RELEASE_WORKFLOW_VERSION = '1.0';
export const EXPECTED_PLUGIN_NAME = 'agent-harness-codex';
export const EXPECTED_MARKETPLACE_NAME = 'agent-harness-local';
export const EXPECTED_PLUGIN_RELATIVE_PATH = 'integrations/codex/agent-harness-codex';
export const REQUIRED_CODEX_MULTI_AGENT_CONTRACT = 'multi-agent-v2';

const stripWindowsDevicePrefix = value => value.replace(/^\\\\\?\\/, '');
const comparablePath = value => stripWindowsDevicePrefix(resolve(value)).replaceAll('\\', '/').toLowerCase();
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));

const resolveExecutable = executable => {
  if (isAbsolute(executable) || dirname(executable) !== '.') return executable;
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map(value => value.toLowerCase())
    : [''];
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = resolve(directory, `${executable}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return executable;
};

const commandLabel = (executable, args, npmCli) => (
  executable === process.execPath && args[0] === npmCli
    ? `npm ${args.slice(1).join(' ')}`
    : `${executable} ${args.join(' ')}`
);

export const createCommandRunner = ({ root, npmCli, onCommand = undefined }) => (
  executable,
  args,
  { json = false } = {},
) => new Promise((resolveRun, reject) => {
  const label = commandLabel(executable, args, npmCli);
  const resolvedExecutable = resolveExecutable(executable);
  onCommand?.({ executable, args: [...args], label });
  process.stderr.write(`[release:start] ${label} [executable=${resolvedExecutable}]\n`);
  let child;
  try {
    child = spawn(resolvedExecutable, args, {
      cwd: root,
      env: process.env,
      windowsHide: true,
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (cause) {
    const error = new Error(`Unable to start ${label} via ${resolvedExecutable}: ${cause.message}`, { cause });
    error.code = 'LOCAL_RELEASE_COMMAND_START_FAILED';
    error.details = { label, executable: resolvedExecutable, causeCode: cause.code };
    reject(error);
    return;
  }
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => {
    stdout += chunk;
    process.stderr.write(chunk);
  });
  child.stderr.on('data', chunk => {
    stderr += chunk;
    process.stderr.write(chunk);
  });
  child.on('error', cause => {
    const error = new Error(`Unable to start ${label} via ${resolvedExecutable}: ${cause.message}`, { cause });
    error.code = 'LOCAL_RELEASE_COMMAND_START_FAILED';
    error.details = { label, executable: resolvedExecutable, causeCode: cause.code };
    reject(error);
  });
  child.on('close', (exitCode, signal) => {
    process.stderr.write(`[release:finish] exit=${exitCode ?? 'null'} signal=${signal ?? 'none'} ${label}\n`);
    if (exitCode !== 0 || signal) {
      const error = new Error(`${label} failed with ${signal ?? `exit code ${exitCode}`}.`);
      error.code = 'LOCAL_RELEASE_COMMAND_FAILED';
      error.details = { label, exitCode, signal, stderr: stderr.trim() };
      reject(error);
      return;
    }
    try {
      resolveRun({ stdout, stderr, json: json ? parseLastJsonDocument(stdout) : undefined });
    } catch (error) {
      reject(error);
    }
  });
});

export const validateLocalReleaseConfiguration = ({ root, packageJson, packageLock, pluginManifest, marketplace }) => {
  const versionErrors = validateReleaseVersionContract({ packageJson, codexPlugin: pluginManifest });
  assert(versionErrors.length === 0, 'LOCAL_RELEASE_VERSION_INVALID', versionErrors.join('; '), { errors: versionErrors });
  assert(packageJson.name === 'agent-harness', 'LOCAL_RELEASE_PACKAGE_INVALID', 'package.json must describe agent-harness.');
  assert(packageJson.version === '1.0.0', 'LOCAL_RELEASE_VERSION_INVALID', 'The frozen V1.0.0 workflow requires package version 1.0.0.');
  assert(packageLock?.packages?.['']?.version === packageJson.version, 'LOCAL_RELEASE_LOCK_VERSION_MISMATCH', 'package-lock.json root version must exactly match package.json.');
  assert(pluginManifest.name === EXPECTED_PLUGIN_NAME, 'LOCAL_RELEASE_PLUGIN_INVALID', `Codex plugin name must be ${EXPECTED_PLUGIN_NAME}.`);
  assert(marketplace?.name === EXPECTED_MARKETPLACE_NAME, 'LOCAL_RELEASE_MARKETPLACE_INVALID', `Marketplace name must be ${EXPECTED_MARKETPLACE_NAME}.`);
  assert(Array.isArray(marketplace.plugins) && marketplace.plugins.length === 1, 'LOCAL_RELEASE_MARKETPLACE_INVALID', 'Local marketplace must expose exactly one plugin.');
  const entry = marketplace.plugins[0];
  assert(entry?.name === EXPECTED_PLUGIN_NAME, 'LOCAL_RELEASE_MARKETPLACE_PLUGIN_MISMATCH', `Marketplace plugin must be ${EXPECTED_PLUGIN_NAME}.`);
  assert(entry?.source?.source === 'local' && typeof entry.source.path === 'string', 'LOCAL_RELEASE_MARKETPLACE_NOT_LOCAL', 'Marketplace plugin source must be local.');
  assert(entry?.policy?.installation === 'AVAILABLE' && entry?.policy?.authentication === 'ON_INSTALL', 'LOCAL_RELEASE_MARKETPLACE_POLICY_MISMATCH', 'Marketplace plugin policy must remain AVAILABLE with ON_INSTALL authentication.');
  assert(!isAbsolute(entry.source.path), 'LOCAL_RELEASE_MARKETPLACE_PATH_INVALID', 'Marketplace plugin source path must be relative to the repository root.');
  const pluginRoot = assertNoLinkPath(root, resolve(root, entry.source.path), 'local Codex plugin source');
  const expectedPluginRoot = assertNoLinkPath(root, resolve(root, EXPECTED_PLUGIN_RELATIVE_PATH), 'expected local Codex plugin source');
  assert(comparablePath(pluginRoot) === comparablePath(expectedPluginRoot), 'LOCAL_RELEASE_MARKETPLACE_PATH_MISMATCH', 'Marketplace must point at the in-repository Codex plugin.', { pluginRoot, expectedPluginRoot });
  assert(!relative(root, pluginRoot).startsWith('..'), 'LOCAL_RELEASE_MARKETPLACE_PATH_INVALID', 'Marketplace plugin source must stay inside the repository.');
  return Object.freeze({
    version: packageJson.version,
    pluginName: pluginManifest.name,
    marketplaceName: marketplace.name,
    pluginId: `${pluginManifest.name}@${marketplace.name}`,
    pluginRoot,
  });
};

export const inspectMarketplaceConfiguration = ({ payload, marketplaceName, root }) => {
  assert(Array.isArray(payload?.marketplaces), 'LOCAL_RELEASE_MARKETPLACE_LIST_INVALID', 'codex plugin marketplace list returned an invalid payload.');
  const matches = payload.marketplaces.filter(entry => entry?.name === marketplaceName);
  assert(matches.length <= 1, 'LOCAL_RELEASE_MARKETPLACE_AMBIGUOUS', `More than one configured marketplace is named ${marketplaceName}.`);
  if (matches.length === 0) return Object.freeze({ configured: false });
  assert(typeof matches[0].root === 'string' && comparablePath(matches[0].root) === comparablePath(root), 'LOCAL_RELEASE_MARKETPLACE_ROOT_MISMATCH', `Configured marketplace ${marketplaceName} points at a different root.`, { configuredRoot: matches[0].root, expectedRoot: root });
  return Object.freeze({ configured: true, root: matches[0].root });
};

export const inspectPluginInstallation = ({ payload, config, requireInstalled = false }) => {
  assert(Array.isArray(payload?.installed) && Array.isArray(payload?.available), 'LOCAL_RELEASE_PLUGIN_LIST_INVALID', 'codex plugin list returned an invalid payload.');
  const matches = payload.installed.filter(entry => entry?.pluginId === config.pluginId);
  assert(matches.length <= 1, 'LOCAL_RELEASE_PLUGIN_AMBIGUOUS', `More than one installed plugin matches ${config.pluginId}.`);
  if (matches.length === 0) {
    assert(!requireInstalled, 'LOCAL_RELEASE_PLUGIN_NOT_INSTALLED', `Plugin ${config.pluginId} was not installed.`);
    return Object.freeze({ installed: false });
  }
  const installed = matches[0];
  assert(installed.name === config.pluginName && installed.marketplaceName === config.marketplaceName, 'LOCAL_RELEASE_PLUGIN_IDENTITY_MISMATCH', 'Installed plugin identity does not match the frozen local configuration.');
  assert(installed.source?.source === 'local' && typeof installed.source.path === 'string', 'LOCAL_RELEASE_PLUGIN_SOURCE_INVALID', 'Installed plugin must have a local source.');
  assert(comparablePath(installed.source.path) === comparablePath(config.pluginRoot), 'LOCAL_RELEASE_PLUGIN_SOURCE_MISMATCH', 'Installed plugin points at a different source tree.', { installedSource: installed.source.path, expectedSource: config.pluginRoot });
  if (requireInstalled) {
    assert(installed.version === config.version, 'LOCAL_RELEASE_PLUGIN_VERSION_MISMATCH', 'Installed plugin version does not match the frozen release version.', { installedVersion: installed.version, expectedVersion: config.version });
    assert(installed.installed === true && installed.enabled === true, 'LOCAL_RELEASE_PLUGIN_INACTIVE', 'Reinstalled plugin must be installed and enabled.');
    assert(installed.installPolicy === 'AVAILABLE' && installed.authPolicy === 'ON_INSTALL', 'LOCAL_RELEASE_PLUGIN_POLICY_MISMATCH', 'Installed plugin policy does not match the frozen marketplace policy.');
  }
  return Object.freeze({ installed: true, version: installed.version, enabled: installed.enabled === true, source: installed.source.path });
};

export const inspectCodexHostFeatures = output => {
  assert(typeof output === 'string', 'LOCAL_RELEASE_CODEX_FEATURES_INVALID', 'codex features list returned an invalid payload.');
  const features = new Map();
  for (const line of output.split(/\r?\n/u)) {
    const match = line.match(/^\s*(multi_agent(?:_v2)?)\s+\S+\s+(true|false)\s*$/u);
    if (match) features.set(match[1], match[2] === 'true');
  }
  assert(features.get('multi_agent') === true, 'LOCAL_RELEASE_MULTI_AGENT_DISABLED', 'Codex native multi-agent support must be enabled before installing Agent Harness. Run `codex features enable multi_agent`, then create a new task.');
  assert(features.get('multi_agent_v2') === true, 'LOCAL_RELEASE_MULTI_AGENT_V2_REQUIRED', 'Agent Harness requires Codex Multi-Agent V2 because its Host Effect protocol depends on collaboration.list_agents and collaboration.interrupt_agent. Run `codex features enable multi_agent_v2`, then create a new task.');
  return Object.freeze({ contract: REQUIRED_CODEX_MULTI_AGENT_CONTRACT, multiAgent: true, multiAgentV2: true });
};

export const createPluginMutationPlan = ({ marketplaceConfigured, pluginInstalled, config }) => {
  const plan = [];
  if (!marketplaceConfigured) plan.push({ id: 'marketplace-add', command: ['codex', 'plugin', 'marketplace', 'add', '<repository-root>', '--json'] });
  if (pluginInstalled) plan.push({ id: 'plugin-remove', command: ['codex', 'plugin', 'remove', config.pluginId, '--json'] });
  plan.push({ id: 'plugin-add', command: ['codex', 'plugin', 'add', config.pluginId, '--json'] });
  plan.push({ id: 'plugin-verify', command: ['codex', 'plugin', 'list', '--marketplace', config.marketplaceName, '--available', '--json'] });
  return Object.freeze(plan.map(step => Object.freeze(step)));
};

const loadActiveReleaseBinding = async ({ root, dataRoot }) => {
  const pointer = await readActiveRelease(dataRoot, root);
  assert(pointer, 'LOCAL_RELEASE_ACTIVE_RELEASE_MISSING', 'Codex plugin bindings require an active release pointer. Activate an exact runtime and Registry generation before installing the plugin.');
  const [runtimeRoot, registryRoot] = await Promise.all([
    resolveActiveRuntimeRoot(dataRoot, root),
    resolveActiveRegistryRoot(dataRoot, root),
  ]);
  const releaseIdentity = await verifyReleaseManifest({ root: runtimeRoot });
  assert(pointer.release?.version === releaseIdentity.version && pointer.release?.artifactDigest === releaseIdentity.artifactDigest && pointer.release?.verified === true, 'LOCAL_RELEASE_ACTIVE_POINTER_IDENTITY_MISMATCH', 'Active release pointer does not match the verified runtime artifact.', { pointerRelease: pointer.release, runtimeRelease: releaseIdentity });
  const entrypoint = assertNoLinkPath(root, resolve(root, pointer.runtimeEntrypoint ?? ''), 'active Harness runtime entrypoint');
  assert(comparablePath(entrypoint) === comparablePath(resolve(runtimeRoot, 'bin', 'agent-harness.mjs')), 'LOCAL_RELEASE_ACTIVE_ENTRYPOINT_MISMATCH', 'Active release runtimeEntrypoint does not match its verified runtime root.', { entrypoint, runtimeRoot });
  const channel = await validateActiveReleaseBinding({ controlRoot: root, dataRoot, entrypoint, verifyAllFiles: true });
  return Object.freeze({
    version: releaseIdentity.version,
    packageDigest: releaseIdentity.artifactDigest,
    generationId: pointer.generationId,
    pointerDigest: pointer.pointerDigest,
    runtimeRoot,
    registryRoot,
    entrypoint,
    channelArtifactDigest: channel.channelArtifactDigest,
  });
};

export const validatePluginBindings = async ({ root, config, bindings, activeReleaseLoader = loadActiveReleaseBinding }) => {
  assert(bindings?.protocolVersion === '1.0' && bindings.harness && bindings.projects, 'LOCAL_RELEASE_BINDINGS_INVALID', 'Codex plugin bindings must use protocolVersion 1.0 and contain harness/projects objects.');
  const { controlRoot, entrypoint: entrypointInput, dataRoot: dataRootInput } = bindings.harness;
  assert(typeof controlRoot === 'string' && comparablePath(controlRoot) === comparablePath(root), 'LOCAL_RELEASE_BINDING_CONTROL_ROOT_MISMATCH', 'Codex plugin binding controlRoot must match the release repository root.', { controlRoot, root });
  assert(isAbsolute(entrypointInput ?? '') && isAbsolute(dataRootInput ?? ''), 'LOCAL_RELEASE_BINDING_PATH_INVALID', 'Codex plugin entrypoint and dataRoot must be absolute paths.');
  const entrypoint = assertNoLinkPath(root, resolve(entrypointInput), 'Codex plugin Harness entrypoint');
  const dataRoot = assertNoLinkPath(root, resolve(dataRootInput), 'Codex plugin Harness data root');
  assert(comparablePath(dataRoot) === comparablePath(resolve(root, '.agent-harness-data')), 'LOCAL_RELEASE_BINDING_DATA_ROOT_MISMATCH', 'Codex plugin dataRoot must be the managed Agent Harness data root.');
  assert((await stat(entrypoint)).isFile(), 'LOCAL_RELEASE_BINDING_ENTRYPOINT_INVALID', 'Codex plugin Harness entrypoint must be an existing file.');
  const activeRelease = await activeReleaseLoader({ root, dataRoot });
  assert(comparablePath(entrypoint) === comparablePath(activeRelease.entrypoint), 'LOCAL_RELEASE_BINDING_ENTRYPOINT_STALE', 'Codex plugin binding entrypoint is not the active verified runtime entrypoint.', { bindingEntrypoint: entrypoint, activeEntrypoint: activeRelease.entrypoint });
  const declaredRelease = bindings.harness.release;
  assert(declaredRelease?.version === activeRelease.version && declaredRelease?.artifactDigest === activeRelease.packageDigest && declaredRelease?.generationId === activeRelease.generationId && declaredRelease?.pointerDigest === activeRelease.pointerDigest, 'LOCAL_RELEASE_BINDING_RELEASE_STALE', 'Codex plugin binding release identity does not match the active release pointer.', { declaredRelease, activeRelease });
  const projectEntries = Object.entries(bindings.projects);
  assert(projectEntries.length > 0, 'LOCAL_RELEASE_BINDINGS_INVALID', 'Codex plugin bindings require at least one project alias.');
  for (const [alias, project] of projectEntries) {
    assert(/^[a-z][a-z0-9-]{0,31}$/.test(alias), 'LOCAL_RELEASE_BINDING_ALIAS_INVALID', `Invalid Codex plugin project alias: ${alias}`);
    assert(['projectId', 'profileId', 'extensionId', 'workspaceRoot'].every(key => typeof project?.[key] === 'string' && project[key].length > 0), 'LOCAL_RELEASE_BINDING_PROJECT_INVALID', `Codex plugin project binding is incomplete: ${alias}`);
    assert(isAbsolute(project.workspaceRoot), 'LOCAL_RELEASE_BINDING_WORKSPACE_INVALID', `Codex plugin workspaceRoot must be absolute: ${alias}`);
    if (project.workspaceIdentity?.commonDir !== undefined) assert(isAbsolute(project.workspaceIdentity.commonDir), 'LOCAL_RELEASE_BINDING_WORKSPACE_INVALID', `Codex plugin Git commonDir must be absolute: ${alias}`);
  }
  return Object.freeze({
    bindingFile: resolve(config.pluginRoot, '.plugin-data', 'bindings.json'),
    digest: digestJson(bindings),
    controlRoot: resolve(controlRoot),
    entrypoint,
    dataRoot,
    release: activeRelease,
    projectAliases: projectEntries.map(([alias]) => alias).sort(),
  });
};

const loadPluginBindings = async ({ root, config }) => {
  const bindingFile = assertNoLinkPath(root, resolve(config.pluginRoot, '.plugin-data', 'bindings.json'), 'Codex plugin bindings');
  assert(existsSync(bindingFile), 'LOCAL_RELEASE_BINDINGS_MISSING', `Codex plugin bindings are missing: ${bindingFile}. Run configure-bindings before release.`);
  return validatePluginBindings({ root, config, bindings: await readJson(bindingFile) });
};

export const loadInstalledPluginBindings = async ({ root, config, codexHome = process.env.CODEX_HOME || (process.env.USERPROFILE ? resolve(process.env.USERPROFILE, '.codex') : null) }) => {
  assert(codexHome && isAbsolute(codexHome), 'LOCAL_RELEASE_CODEX_HOME_REQUIRED', 'Installed plugin binding verification requires an exact absolute CODEX_HOME.');
  const bindingFile = resolve(codexHome, 'plugins', 'cache', config.marketplaceName, config.pluginName, config.version, '.plugin-data', 'bindings.json');
  assert(existsSync(bindingFile), 'LOCAL_RELEASE_INSTALLED_BINDINGS_MISSING', `Installed Codex plugin bindings are missing: ${bindingFile}`);
  const validated = await validatePluginBindings({ root, config, bindings: await readJson(bindingFile) });
  return Object.freeze({ ...validated, bindingFile });
};

const sourceSnapshot = async ({ runner, root }) => {
  const { stdout: topLevelOutput } = await runner('git', ['rev-parse', '--show-toplevel']);
  const { stdout: commitOutput } = await runner('git', ['rev-parse', 'HEAD']);
  const { stdout: statusOutput } = await runner('git', ['status', '--porcelain=v1', '--untracked-files=all']);
  const topLevel = topLevelOutput.trim();
  const commit = commitOutput.trim().toLowerCase();
  assert(comparablePath(topLevel) === comparablePath(root), 'LOCAL_RELEASE_WRONG_REPOSITORY', 'Release workflow must run from the Agent Harness repository root.', { topLevel, root });
  assert(/^[a-f0-9]{40,64}$/.test(commit), 'LOCAL_RELEASE_COMMIT_INVALID', 'Release workflow requires a full Git commit identity.');
  assert(statusOutput.trim() === '', 'LOCAL_RELEASE_SOURCE_DIRTY', 'Release workflow refuses a dirty source tree. Regenerate release metadata, review, and commit the exact source first.');
  return Object.freeze({ commit, clean: true });
};

const assertSourceUnchanged = async ({ runner, root, expectedCommit }) => {
  const snapshot = await sourceSnapshot({ runner, root });
  assert(snapshot.commit === expectedCommit, 'LOCAL_RELEASE_SOURCE_CHANGED', 'Git HEAD changed while the release workflow was running.', { expectedCommit, actualCommit: snapshot.commit });
};

const loadConfiguration = async root => {
  const [packageJson, packageLock, pluginManifest, marketplace] = await Promise.all([
    readJson(resolve(root, 'package.json')),
    readJson(resolve(root, 'package-lock.json')),
    readJson(resolve(root, EXPECTED_PLUGIN_RELATIVE_PATH, '.codex-plugin', 'plugin.json')),
    readJson(resolve(root, '.agents', 'plugins', 'marketplace.json')),
  ]);
  return validateLocalReleaseConfiguration({ root, packageJson, packageLock, pluginManifest, marketplace });
};

const npmRun = (runner, npmCli, script) => runner(process.execPath, [npmCli, 'run', script], { json: ['build:release-candidate', 'pack:core', 'pack:codex'].includes(script) });
const receiptPayload = value => ({ ...value, receiptDigest: digestJson(value) });

const writeWorkflowReceipt = async ({ root, runId, value }) => {
  const directory = assertHarnessWritePath(resolve(root, '.agent-harness-data', 'release-workflows', runId), 'local release workflow receipt directory', root);
  await mkdir(directory, { recursive: true });
  const file = resolve(directory, 'local-plugin-release-receipt.json');
  await writeFile(file, `${JSON.stringify(receiptPayload(value), null, 2)}\n`, 'utf8');
  return file;
};

const acquireReleaseLock = async ({ root, source, startedAt }) => {
  const directory = assertHarnessWritePath(resolve(root, '.agent-harness-data', 'release-workflows'), 'local release workflow root', root);
  await mkdir(directory, { recursive: true });
  const file = resolve(directory, '.local-plugin-release.lock');
  let handle;
  try {
    handle = await open(file, 'wx');
  } catch (error) {
    assert(error.code !== 'EEXIST', 'LOCAL_RELEASE_ALREADY_RUNNING', `Another local plugin release workflow holds ${file}. If no workflow is running, inspect and remove only this stale lock.`, { lockFile: file });
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify({ protocolVersion: '1.0', pid: process.pid, commit: source.commit, startedAt }, null, 2)}\n`, 'utf8');
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(file, { force: true }).catch(() => {});
    throw error;
  }
  return Object.freeze({ file, release: () => rm(file, { force: true }) });
};

export const runLocalPluginRelease = async ({ root: rootInput, mode, npmCli, runner: runnerInput = undefined, bindingsLoader = loadPluginBindings, installedBindingsLoader = loadInstalledPluginBindings, clock = () => new Date() }) => {
  const root = resolve(rootInput);
  assert(['check', 'apply'].includes(mode), 'LOCAL_RELEASE_MODE_INVALID', 'Local release workflow mode must be check or apply.');
  assert(Number(process.versions.node.split('.')[0]) >= 22, 'LOCAL_RELEASE_NODE_UNSUPPORTED', 'Local release workflow requires Node.js 22 or newer.');
  assert(typeof npmCli === 'string' && npmCli.length > 0, 'NPM_EXECUTABLE_REQUIRED', 'Local release workflow must be started through npm.');
  const runner = runnerInput ?? createCommandRunner({ root, npmCli });
  const config = await loadConfiguration(root);
  const source = await sourceSnapshot({ runner, root });
  const releaseIdentity = await verifyReleaseManifest({ root });
  assert(releaseIdentity.version === config.version, 'LOCAL_RELEASE_MANIFEST_VERSION_MISMATCH', 'Release manifest version does not match package.json.');
  const bindings = await bindingsLoader({ root, config });
  assert(bindings.release?.packageDigest === releaseIdentity.artifactDigest, 'LOCAL_RELEASE_ACTIVE_RUNTIME_STALE', 'The active bound runtime does not match the source release artifact. Build and explicitly activate the exact candidate before reinstalling the plugin.', { sourcePackageDigest: releaseIdentity.artifactDigest, activePackageDigest: bindings.release?.packageDigest ?? null });

  const codexFeatures = await runner('codex', ['features', 'list']);
  const hostCapabilities = inspectCodexHostFeatures(codexFeatures.stdout);

  const marketplaceList = await runner('codex', ['plugin', 'marketplace', 'list', '--json'], { json: true });
  let marketplaceState = inspectMarketplaceConfiguration({ payload: marketplaceList.json, marketplaceName: config.marketplaceName, root });
  let pluginState = Object.freeze({ installed: false });
  if (marketplaceState.configured) {
    const pluginList = await runner('codex', ['plugin', 'list', '--marketplace', config.marketplaceName, '--available', '--json'], { json: true });
    pluginState = inspectPluginInstallation({ payload: pluginList.json, config });
  }
  let installedBindings = null;
  if (mode === 'check' && pluginState.installed) {
    installedBindings = await installedBindingsLoader({ root, config });
    assert(installedBindings.digest === bindings.digest, 'LOCAL_RELEASE_INSTALLED_BINDINGS_STALE', 'Installed Codex plugin bindings do not match the verified source binding.', { sourceBindingDigest: bindings.digest, installedBindingDigest: installedBindings.digest, installedBindingFile: installedBindings.bindingFile });
  }
  const mutationPlan = createPluginMutationPlan({ marketplaceConfigured: marketplaceState.configured, pluginInstalled: pluginState.installed, config });
  const common = {
    protocolVersion: '1.0',
    kind: 'local-plugin-release-workflow-receipt',
    workflowVersion: LOCAL_RELEASE_WORKFLOW_VERSION,
    mode,
    source,
    release: { version: config.version, packageDigest: releaseIdentity.artifactDigest },
    plugin: { id: config.pluginId, source: config.pluginRoot },
    hostCapabilities,
    bindings,
    installedBindings,
    mutationPlan,
  };
  if (mode === 'check') return Object.freeze({ ok: true, ...common, marketplaceConfigured: marketplaceState.configured, pluginInstalled: pluginState.installed });

  const startedAt = clock().toISOString();
  const runId = `${startedAt.replaceAll(':', '').replaceAll('.', '-')}-${source.commit.slice(0, 12)}`;
  const releaseLock = await acquireReleaseLock({ root, source, startedAt });
  const steps = [];
  let candidate;
  let removed = false;
  const channelPackages = {};
  try {
    for (const script of ['check', 'test', 'workspace:canary', 'check:clean-room', 'pack:core', 'pack:codex', 'check:residue']) {
      const stageStartedAt = clock().toISOString();
      const stageResult = await npmRun(runner, npmCli, script);
      if (script === 'pack:core') assert(stageResult.json?.ok === true && stageResult.json?.channel === 'core' && stageResult.json?.packageDigest === releaseIdentity.artifactDigest, 'LOCAL_RELEASE_CORE_PACKAGE_INVALID', 'Core channel package does not match the verified release manifest.');
      if (script === 'pack:codex') assert(stageResult.json?.ok === true && stageResult.json?.channel === 'codex' && stageResult.json?.requiredCorePackageDigest === releaseIdentity.artifactDigest, 'LOCAL_RELEASE_CODEX_PACKAGE_INVALID', 'Codex channel package does not bind the verified Core package.');
      if (script === 'pack:core') channelPackages.core = stageResult.json;
      if (script === 'pack:codex') channelPackages.codex = stageResult.json;
      steps.push({ id: script, status: 'passed', startedAt: stageStartedAt, completedAt: clock().toISOString(), ...(stageResult.json?.archiveDigest ? { archiveDigest: stageResult.json.archiveDigest, packageReceipt: stageResult.json.receipt } : {}) });
    }
    const compositionStartedAt = clock().toISOString();
    await runner(process.execPath, [resolve(root, 'scripts/check-channel-composition.mjs'), '--core', channelPackages.core.archive, '--codex', channelPackages.codex.archive]);
    steps.push({ id: 'check:channel-composition', status: 'passed', startedAt: compositionStartedAt, completedAt: clock().toISOString() });
    assert(bindings.release.channelArtifactDigest === channelPackages.codex.artifactDigest, 'LOCAL_RELEASE_CODEX_CHANNEL_STALE', 'The deployed Codex overlay does not match the source channel package.');
    await assertSourceUnchanged({ runner, root, expectedCommit: source.commit });
    const candidateStartedAt = clock().toISOString();
    const candidateResult = await npmRun(runner, npmCli, 'build:release-candidate');
    candidate = candidateResult.json;
    assert(candidate?.ok === true && typeof candidate.receipt === 'string' && typeof candidate.archive === 'string' && typeof candidate.archiveDigest === 'string' && typeof candidate.packageDigest === 'string', 'LOCAL_RELEASE_CANDIDATE_INVALID', 'Release candidate builder returned an invalid receipt.');
    const candidateReceiptFile = assertNoLinkPath(root, resolve(candidate.receipt), 'local Release Candidate receipt');
    const candidateArchiveFile = assertNoLinkPath(root, resolve(candidate.archive), 'local Release Candidate archive');
    const verifiedCandidate = verifyReleaseCandidateReceipt(await readJson(candidateReceiptFile));
    const archiveBytes = await readFile(candidateArchiveFile);
    assert(verifiedCandidate.source.commit === source.commit && verifiedCandidate.source.clean === true, 'LOCAL_RELEASE_CANDIDATE_SOURCE_MISMATCH', 'Release Candidate receipt is not bound to the frozen clean commit.');
    assert(verifiedCandidate.version === config.version, 'LOCAL_RELEASE_CANDIDATE_VERSION_MISMATCH', 'Release Candidate version does not match the frozen plugin version.');
    assert(verifiedCandidate.releaseManifest.packageDigest === releaseIdentity.artifactDigest && candidate.packageDigest === releaseIdentity.artifactDigest, 'LOCAL_RELEASE_CANDIDATE_PACKAGE_MISMATCH', 'Release Candidate package digest does not match the verified release manifest.');
    assert(verifiedCandidate.archive.sha256 === candidate.archiveDigest && sha256(archiveBytes) === candidate.archiveDigest, 'LOCAL_RELEASE_CANDIDATE_ARCHIVE_MISMATCH', 'Release Candidate archive bytes do not match the candidate receipt.');
    steps.push({ id: 'build:release-candidate', status: 'passed', startedAt: candidateStartedAt, completedAt: clock().toISOString(), candidateReceipt: candidate.receipt, archiveDigest: candidate.archiveDigest });
    await assertSourceUnchanged({ runner, root, expectedCommit: source.commit });
    const currentBindings = await bindingsLoader({ root, config });
    assert(currentBindings.digest === bindings.digest, 'LOCAL_RELEASE_BINDINGS_CHANGED', 'Codex plugin bindings changed while the release workflow was running. Restart from preflight.');
    assert(currentBindings.release?.packageDigest === candidate.packageDigest, 'LOCAL_RELEASE_ACTIVE_RUNTIME_STALE', 'The active bound runtime does not match the verified Release Candidate. Activate that exact candidate before changing the plugin installation.', { candidatePackageDigest: candidate.packageDigest, activePackageDigest: currentBindings.release?.packageDigest ?? null });

    const liveMarketplaceList = await runner('codex', ['plugin', 'marketplace', 'list', '--json'], { json: true });
    marketplaceState = inspectMarketplaceConfiguration({ payload: liveMarketplaceList.json, marketplaceName: config.marketplaceName, root });
    if (!marketplaceState.configured) {
      const stageStartedAt = clock().toISOString();
      await runner('codex', ['plugin', 'marketplace', 'add', root, '--json'], { json: true });
      const refreshed = await runner('codex', ['plugin', 'marketplace', 'list', '--json'], { json: true });
      marketplaceState = inspectMarketplaceConfiguration({ payload: refreshed.json, marketplaceName: config.marketplaceName, root });
      assert(marketplaceState.configured, 'LOCAL_RELEASE_MARKETPLACE_ADD_FAILED', `Marketplace ${config.marketplaceName} was not configured after add.`);
      steps.push({ id: 'marketplace-add', status: 'passed', startedAt: stageStartedAt, completedAt: clock().toISOString() });
    }

    const currentList = await runner('codex', ['plugin', 'list', '--marketplace', config.marketplaceName, '--available', '--json'], { json: true });
    pluginState = inspectPluginInstallation({ payload: currentList.json, config });
    if (pluginState.installed) {
      const stageStartedAt = clock().toISOString();
      await runner('codex', ['plugin', 'remove', config.pluginId, '--json'], { json: true });
      const afterRemoveList = await runner('codex', ['plugin', 'list', '--marketplace', config.marketplaceName, '--available', '--json'], { json: true });
      const afterRemove = inspectPluginInstallation({ payload: afterRemoveList.json, config });
      assert(afterRemove.installed === false, 'LOCAL_RELEASE_PLUGIN_CACHE_NOT_CLEARED', `Plugin ${config.pluginId} is still installed after remove.`);
      removed = true;
      steps.push({ id: 'plugin-remove', status: 'passed', startedAt: stageStartedAt, completedAt: clock().toISOString(), cacheCleared: true });
    }

    const addStartedAt = clock().toISOString();
    await runner('codex', ['plugin', 'add', config.pluginId, '--json'], { json: true });
    steps.push({ id: 'plugin-add', status: 'passed', startedAt: addStartedAt, completedAt: clock().toISOString() });
    const verifyStartedAt = clock().toISOString();
    const finalList = await runner('codex', ['plugin', 'list', '--marketplace', config.marketplaceName, '--available', '--json'], { json: true });
    const installed = inspectPluginInstallation({ payload: finalList.json, config, requireInstalled: true });
    installedBindings = await installedBindingsLoader({ root, config });
    assert(installedBindings.digest === currentBindings.digest, 'LOCAL_RELEASE_INSTALLED_BINDINGS_STALE', 'Reinstalled Codex plugin bindings do not match the verified source binding.', { sourceBindingDigest: currentBindings.digest, installedBindingDigest: installedBindings.digest, installedBindingFile: installedBindings.bindingFile });
    steps.push({ id: 'plugin-verify', status: 'passed', startedAt: verifyStartedAt, completedAt: clock().toISOString(), installedVersion: installed.version, enabled: installed.enabled, source: installed.source, bindingDigest: installedBindings.digest, bindingFile: installedBindings.bindingFile });
    await assertSourceUnchanged({ runner, root, expectedCommit: source.commit });

    const completedAt = clock().toISOString();
    const value = { ...common, installedBindings, runId, status: 'completed', startedAt, completedAt, candidate, removedExistingInstallation: removed, steps };
    const receipt = await writeWorkflowReceipt({ root, runId, value });
    return Object.freeze({ ok: true, ...value, receipt });
  } catch (error) {
    const completedAt = clock().toISOString();
    const failedStep = error?.details?.label ?? error?.code ?? 'unknown';
    const value = { ...common, runId, status: 'failed', startedAt, completedAt, candidate: candidate ?? null, removedExistingInstallation: removed, steps, failure: { code: error?.code ?? 'LOCAL_RELEASE_FAILED', message: error?.message ?? String(error), failedStep } };
    const receipt = await writeWorkflowReceipt({ root, runId, value });
    error.receipt = receipt;
    throw error;
  } finally {
    await releaseLock.release();
  }
};
