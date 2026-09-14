import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { digestJson, sha256 } from '../src/canonical.mjs';
import { assert } from '../src/errors.mjs';
import { assertHarnessWritePath, temporaryEnvironment } from '../src/write-boundary.mjs';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const take = name => {
  const index = process.argv.indexOf(name);
  assert(index >= 0 && process.argv[index + 1], 'CUTOVER_ARGUMENT_REQUIRED', `Missing ${name}.`);
  return process.argv[index + 1];
};
const absolute = (value, label) => {
  assert(isAbsolute(value), 'CUTOVER_ABSOLUTE_PATH_REQUIRED', `${label} must be absolute.`);
  return resolve(value);
};
const inside = (parent, child) => {
  const value = relative(parent, child);
  return value === '' || (!value.startsWith('..') && !isAbsolute(value));
};
const run = (executable, args, { cwd, environment }) => new Promise((resolveRun, reject) => {
  process.stderr.write(`[process:start] ${executable} ${args.join(' ')}\n`);
  const child = spawn(executable, args, { cwd, env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; process.stderr.write(chunk); });
  child.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(chunk); });
  child.on('error', error => { process.stderr.write(`[process:error] ${error.message}\n`); reject(error); });
  child.on('close', (exitCode, signal) => {
    process.stderr.write(`[process:finish] exit=${exitCode ?? 'null'} signal=${signal ?? 'none'}\n`);
    if (exitCode === 0 && !signal) resolveRun({ stdout, stderr });
    else reject(Object.assign(new Error(`${executable} exited with ${signal ?? exitCode}: ${stderr.trim()}`), { code: 'CUTOVER_COMMAND_FAILED', exitCode, signal }));
  });
});

const candidateReceiptFile = absolute(take('--candidate-receipt'), 'candidate receipt');
const cardworldRoot = absolute(take('--cardworld-root'), 'CardWorld root');
const collectionRoot = absolute(take('--collection-root'), 'Collection root');
const outputRoot = assertHarnessWritePath(absolute(take('--output-root'), 'cutover output root'), 'cutover output root', sourceRoot);
const dispositionFile = resolve(sourceRoot, 'docs', 'acceptance', 'evidence', 'cutover-source-dispositions.json');
const candidateReceipt = JSON.parse(await readFile(candidateReceiptFile, 'utf8'));
const archiveFile = resolve(dirname(candidateReceiptFile), candidateReceipt.archive.fileName);
assert(sha256(await readFile(archiveFile)) === candidateReceipt.archive.sha256, 'CUTOVER_ARCHIVE_DIGEST_MISMATCH', 'Candidate archive does not match its Receipt.');
const npmCandidates = [
  process.env.npm_execpath,
  resolve(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  resolve(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
].filter(Boolean);
let npmCli = null;
for (const candidate of npmCandidates) {
  try { await access(candidate); npmCli = candidate; break; } catch {}
}
assert(npmCli, 'NPM_EXECUTABLE_REQUIRED', 'Clean-start Canary requires an npm CLI next to Node or in npm_execpath.');
const git = await run('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, environment: {} });
assert(git.stdout.trim().toLowerCase() === candidateReceipt.source.commit, 'CUTOVER_SOURCE_COMMIT_MISMATCH', 'Candidate Receipt does not bind the current source commit.');

const controlRoot = assertHarnessWritePath(resolve(outputRoot, `standalone-${candidateReceipt.source.commit.slice(0, 12)}-${candidateReceipt.archive.sha256.slice(0, 12)}`), 'cutover control root', sourceRoot);
const cleanupTransient = () => {
  for (const path of [resolve(controlRoot, '.tmp'), resolve(controlRoot, '.npm-cache')]) {
    try { rmSync(path, { recursive: true, force: true }); } catch {}
  }
};
process.on('exit', cleanupTransient);
const marker = resolve(controlRoot, '.agent-harness-installation.json');
try {
  await readFile(marker);
  assert(false, 'CUTOVER_CONTROL_ROOT_EXISTS', 'Cutover control root already exists; choose a new output root instead of overwriting Authority.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await mkdir(controlRoot, { recursive: true });
const processTemporary = resolve(controlRoot, '.tmp', 'process');
await mkdir(processTemporary, { recursive: true });
const environment = {
  ...temporaryEnvironment(processTemporary, sourceRoot),
  NPM_CONFIG_CACHE: resolve(controlRoot, '.npm-cache'),
  NPM_CONFIG_LOGS_DIR: resolve(controlRoot, '.tmp', 'npm-logs'),
  NPM_CONFIG_LOGS_MAX: '0',
  NPM_CONFIG_UPDATE_NOTIFIER: 'false',
};
await run(process.execPath, [npmCli, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', '--save=false', '--prefix', controlRoot, archiveFile], { cwd: controlRoot, environment });

const installedRoot = resolve(controlRoot, 'node_modules', 'agent-harness');
const installed = await import(pathToFileURL(resolve(installedRoot, 'src', 'index.mjs')).href);
const releaseIdentity = await installed.verifyReleaseManifest({ root: installedRoot, artifactDigest: candidateReceipt.releaseManifest.packageDigest });
installed.verifyReleaseCandidateReceipt(candidateReceipt);
await installed.initializeHarnessInstallation({ controlRoot });
const dataRoot = resolve(controlRoot, '.agent-harness-data');
const registry = new installed.ExtensionRegistry({ controlRoot, dataRoot });
const decision = { actor: 'project-owner', decision: 'approved', reason: 'authorized clean-start canary after legacy Authority disposition' };
const cardEntry = resolve(installedRoot, 'src', 'consumers', 'cardworld-engine.mjs');
const collectionEntry = resolve(installedRoot, 'src', 'consumers', 'tabletop-collection.mjs');
await registry.register(cardEntry, { expectedRevision: 0, commandId: 'cutover-register-cardworld-v1', authorityDecision: decision });
await registry.register(collectionEntry, { expectedRevision: 1, commandId: 'cutover-register-collection-v1', authorityDecision: decision });
const extensions = await registry.loadInstalled();
const extensionById = new Map(extensions.map(extension => [extension.id, extension]));
const harness = await installed.createHarness({ controlRoot, dataRoot, extensions, releaseIdentity });
const runtimeManifest = { id: 'cutover-in-memory-runtime', kind: 'agent-runtime', version: '1.0.0', capabilities: ['spawn', 'wait', 'send', 'heartbeat', 'interrupt', 'headless'], permissions: [] };
harness.registerPlugin(runtimeManifest, installed.createInMemoryRuntime({ manifest: runtimeManifest, handler: async packet => ({ status: 'completed', summary: `clean-start canary completed for ${packet.projectId}`, changedFiles: [] }) }));

const exactExtensions = descriptor => ({
  ...descriptor,
  extensions: descriptor.extensions.map(extension => {
    const loaded = extensionById.get(extension.id);
    assert(loaded, 'CUTOVER_EXTENSION_NOT_INSTALLED', `Required Extension is not installed: ${extension.id}`);
    return { id: loaded.id, version: loaded.version, digest: loaded.digest };
  }),
  gateRecipes: [],
});
const cardExtension = extensionById.get('cardworld-engine-profile');
const collectionExtension = extensionById.get('tabletop-collection-profile');
const harnessIdentity = { version: releaseIdentity.version, artifactDigest: releaseIdentity.artifactDigest };
const descriptors = [
  exactExtensions(cardExtension.operations.createProjectDescriptor({ id: 'cardworld-engine-clean-start', harness: harnessIdentity, workspaceRoot: cardworldRoot, runtimePluginId: runtimeManifest.id, agentExecutionMode: 'headless', runtimeExtension: null })),
  exactExtensions(collectionExtension.operations.createProjectDescriptor({ id: 'tabletop-collection-clean-start', harness: harnessIdentity, workspaceRoot: collectionRoot, runtimePluginId: runtimeManifest.id, agentExecutionMode: 'headless', runtimeExtension: null })),
];
for (const descriptor of descriptors) await harness.projectRegistry.register(descriptor, { expectedRevision: 0, commandId: `cutover-register-project-${descriptor.id}` });

let sequence = 0;
const command = state => ({ commandId: `cutover-command-${++sequence}`, ...(state ? { expectedRevision: state.revision } : {}) });
const executeCanary = async ({ descriptor, profileId, feature, profileConfig, preDispatchDecisions = [] }) => {
  const before = await installed.captureWorkspace(descriptor.workspace.root, { excluded: descriptor.workspace.excluded ?? [] });
  let state = (await harness.startRun({ projectId: descriptor.id, runId: 'v1-clean-start-canary', profileId, features: [feature], profileConfig, artifactDigest: releaseIdentity.artifactDigest }, command())).state;
  for (const id of preDispatchDecisions) state = (await harness.kernel.recordDecision(descriptor.id, state.runId, { id, actor: 'project-owner', decision: 'approved' }, command(state))).state;
  const scheduled = await harness.dispatch(descriptor.id, state.runId, { maxConcurrency: 1, runtimePluginId: runtimeManifest.id }, command(state));
  state = scheduled.state;
  const dispatch = scheduled.result.dispatches[0];
  assert(dispatch, 'CUTOVER_DISPATCH_MISSING', `No Canary Dispatch was created for ${descriptor.id}.`);
  const spawned = await harness.spawnDispatch(descriptor.id, state.runId, dispatch.dispatchId, runtimeManifest.id, command().commandId);
  const waited = await harness.invokeBoundRuntime(descriptor.id, state.runId, dispatch.dispatchId, 'wait');
  const recorded = await harness.recordResult(descriptor.id, state.runId, dispatch.dispatchId, waited.payload.result, { commandId: command().commandId, runtimeEvidence: waited });
  const closed = await harness.kernel.closeRun(descriptor.id, state.runId, {}, command(recorded.state));
  const after = await installed.captureWorkspace(descriptor.workspace.root, { excluded: descriptor.workspace.excluded ?? [] });
  const changedFiles = installed.diffWorkspaceSnapshots(before, after);
  assert(changedFiles.length === 0 && before.digest === after.digest, 'CUTOVER_BUSINESS_WORKSPACE_CHANGED', `Canary changed the business workspace for ${descriptor.id}.`, { changedFiles });
  return {
    projectId: descriptor.id,
    profileId,
    descriptorDigest: descriptor.descriptorDigest,
    workspaceRoot: descriptor.workspace.root,
    workspaceDigestBefore: before.digest,
    workspaceDigestAfter: after.digest,
    businessWorkspaceUnchanged: true,
    runId: closed.state.runId,
    runStatus: closed.state.status,
    runReceiptDigest: closed.result.receipt.receiptDigest,
    runReceiptFile: relative(controlRoot, closed.result.receiptFile).replaceAll('\\', '/'),
    authorityDigest: closed.state.authorityDigest,
  };
};

const results = [];
results.push(await executeCanary({
  descriptor: await harness.projectRegistry.get('cardworld-engine-clean-start'),
  profileId: 'engine-delivery',
  feature: { id: 'cutover/cardworld-verification', kind: 'verification', ownerRole: 'operator', logicalRoot: 'cutover:cardworld', laneId: 'cutover', acceptance: ['The installed candidate completes a no-write CardWorld canary.'], dependsOn: [], allowedPaths: [], metadata: { stage: 'canonical-requirement' } },
  profileConfig: { requireCanonicalDecision: false, requireUserCodeReview: false, requiredFinalGates: [] },
}));
results.push(await executeCanary({
  descriptor: await harness.projectRegistry.get('tabletop-collection-clean-start'),
  profileId: 'collection-batch',
  feature: { id: 'cutover/collection-verification', kind: 'verification', ownerRole: 'operator', logicalRoot: 'cutover:collection', laneId: 'cutover', acceptance: ['The installed candidate completes a no-write Collection canary.'], dependsOn: [], allowedPaths: [], metadata: { batchId: 'clean-start', gameId: 'cutover-canary', ruleStatus: 'rule-ready' } },
  profileConfig: { activeBatch: 'clean-start', batches: [{ id: 'clean-start', order: 1, status: 'active' }], requireRuleReady: false, requireHarnessAcceptance: false, requireIndependentReview: false, requireUserGameAcceptance: false, requireBatchCloseDecision: false, requiredFinalGates: [] },
  preDispatchDecisions: ['batch:clean-start:launched'],
}));

const dispositions = JSON.parse(await readFile(dispositionFile, 'utf8'));
const extensionRegistry = await registry.list();
const receiptBody = {
  protocolVersion: '1.0',
  kind: 'clean-start-cutover-canary-receipt',
  candidate: { sourceCommit: candidateReceipt.source.commit, candidateReceiptDigest: candidateReceipt.receiptDigest, archiveSha256: candidateReceipt.archive.sha256, packageDigest: releaseIdentity.artifactDigest },
  legacyDisposition: { summarySha256: sha256(await readFile(dispositionFile)), receiptRefs: dispositions.projects.map(project => project.receiptRef).sort() },
  control: { root: controlRoot, dataRoot, stateOutsideBusinessWorkspaces: !inside(cardworldRoot, dataRoot) && !inside(collectionRoot, dataRoot), installationMarker: relative(controlRoot, marker).replaceAll('\\', '/'), extensionRegistryRevision: extensionRegistry.revision, extensionRegistryDigest: extensionRegistry.registryDigest },
  extensions: extensionRegistry.extensions.map(extension => ({ id: extension.id, version: extension.version, digest: extension.digest })),
  projects: results,
  createdAt: new Date().toISOString(),
};
assert(receiptBody.control.stateOutsideBusinessWorkspaces, 'CUTOVER_STATE_INSIDE_BUSINESS_WORKSPACE', 'Cutover state must remain outside both business workspaces.');
const receipt = { ...receiptBody, receiptDigest: digestJson(receiptBody) };
const receiptDirectory = resolve(outputRoot, 'receipts', receipt.receiptDigest);
await mkdir(receiptDirectory, { recursive: true });
const receiptFile = resolve(receiptDirectory, 'clean-start-cutover-canary-receipt.json');
await writeFile(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
await rm(resolve(controlRoot, '.tmp'), { recursive: true, force: true });
await rm(resolve(controlRoot, '.npm-cache'), { recursive: true, force: true });
console.log(JSON.stringify({ ok: true, controlRoot, receiptFile, receiptDigest: receipt.receiptDigest, projects: results.map(result => ({ projectId: result.projectId, profileId: result.profileId, status: result.runStatus, runReceiptDigest: result.runReceiptDigest, businessWorkspaceUnchanged: result.businessWorkspaceUnchanged })) }, null, 2));
