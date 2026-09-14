import { mkdtemp, mkdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHarness, createInMemoryRuntime, harnessTemporaryRoot } from '../src/index.mjs';
import { extensionPack as engineDeliveryExtension } from '../src/consumers/cardworld-engine.mjs';
import { extensionPack as collectionBatchExtension } from '../src/consumers/tabletop-collection.mjs';

let sequence = 0;
export const command = state => ({ commandId: `test-command-${++sequence}`, ...(state ? { expectedRevision: state.revision } : {}) });

export const makeFixture = async ({ projectId = 'project', profiles = ['feature-delivery'], policy = {}, gateRecipes = [], artifactProviders = [], extensions = [], agentAdapter = null, releaseIdentity = { version: '1.0.0', artifactDigest: null } } = {}) => {
  const parent = resolve(harnessTemporaryRoot(), 'tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'case-'));
  const workspace = resolve(root, 'workspace');
  const dataRoot = resolve(root, 'data');
  await mkdir(workspace, { recursive: true });
  await writeFile(resolve(workspace, 'README.md'), '# Fixture\n', 'utf8');
  const profileExtensions = [
    ...(profiles.includes('engine-delivery') ? [engineDeliveryExtension] : []),
    ...(profiles.includes('collection-batch') ? [collectionBatchExtension] : []),
  ];
  const cleanup = async () => {
    await rm(root, { recursive: true, force: true });
    await rmdir(parent).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
    await rmdir(harnessTemporaryRoot()).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
  };
  try {
    const harness = await createHarness({ dataRoot, releaseIdentity, strictProjectIdentity: false, extensions: [...profileExtensions, ...extensions], agentAdapter });
    const testRuntimeManifest = { id: 'test-runtime', kind: 'agent-runtime', version: '1.0.0', capabilities: ['spawn', 'wait', 'send', 'heartbeat', 'interrupt', 'headless'], permissions: [] };
    harness.registerPlugin(testRuntimeManifest, createInMemoryRuntime({ manifest: testRuntimeManifest, handler: async () => ({ status: 'completed', summary: 'test runtime completed' }) }));
    await harness.projectRegistry.register({ id: projectId, workspace: { root: workspace }, profiles, policy: { agentExecutionMode: 'headless', runtimePlugins: ['test-runtime'], defaultRuntimePlugin: 'test-runtime', ...policy }, gateRecipes, artifactProviders }, { commandId: `register-${projectId}` });
    return { root, workspace, dataRoot, harness, projectId, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
};

export const feature = (id, metadata = {}, extra = {}) => ({ id, acceptance: [`${id} accepted`], dependsOn: [], allowedPaths: [`work/${id}`], metadata, ...extra });

export const startRun = async (fixture, { runId = 'run', profileId = 'feature-delivery', features = [feature('one')], profileConfig = {}, artifactDigest = null } = {}) => {
  const output = await fixture.harness.startRun({ projectId: fixture.projectId, runId, profileId, features, profileConfig, artifactDigest }, command());
  return output.state;
};

export const dispatchAndBind = async (fixture, runId, { maxConcurrency = 1, index = 0 } = {}) => {
  let state = await fixture.harness.authorityStore.read(fixture.projectId, runId);
  const scheduled = await fixture.harness.dispatch(fixture.projectId, runId, { maxConcurrency, runtimePluginId: 'test-runtime' }, command(state));
  const dispatch = scheduled.result.dispatches[index];
  if (!dispatch) return { state: scheduled.state, dispatch: null, lease: null, dispatches: scheduled.result.dispatches };
  state = scheduled.state;
  const bound = await fixture.harness.bindDispatch(fixture.projectId, runId, { dispatchId: dispatch.dispatchId, agentId: `agent-${dispatch.dispatchId}`, runtimeReceipt: { runtimePluginId: 'test-runtime', receiptId: `receipt-${dispatch.dispatchId}` } }, command(state));
  return { state: bound.state, dispatch, lease: bound.result.lease, dispatches: scheduled.result.dispatches };
};

export const recordResult = async (fixture, runId, dispatch, result = { status: 'completed', summary: 'done' }) => fixture.harness.recordResult(fixture.projectId, runId, dispatch.dispatchId, result, { commandId: command().commandId });
