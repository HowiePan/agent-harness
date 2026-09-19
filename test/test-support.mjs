import { mkdtemp, mkdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createExecutionAuthorizationAdapter, createHarness, createInMemoryRuntime, harnessTemporaryRoot, projectExecutionPolicyDecisionContext, sealLifecycleExecutionGrant } from '../src/index.mjs';
import { extensionPack as engineDeliveryExtension } from '../src/flows/delivery-lifecycle/index.mjs';
import { extensionPack as collectionBatchExtension } from '../src/flows/batch-production/index.mjs';

let sequence = 0;
export const command = state => ({ commandId: `test-command-${++sequence}`, ...(state ? { expectedRevision: state.revision } : {}) });

export const createTestExecutionAuthorizationAdapter = (constraintOverrides = {}) => createExecutionAuthorizationAdapter({
  provider: 'test-host',
  constraints: { processBackedAgent: 'allow-explicit', unattended: 'allow-explicit', decisionLineage: 'test-user-explicit-policy', ...constraintOverrides },
  authorizeExecution: ({ context, evidence }) => {
    if (evidence?.explicitUnattended !== true) return null;
    return sealLifecycleExecutionGrant({
      protocolVersion: '1.0',
      kind: 'lifecycle-execution-grant',
      grantId: `test-grant-${context.runId}`,
      actor: 'test-user',
      decision: 'approved',
      interactionMode: 'unattended',
      context,
      issuedAt: '2026-09-15T00:00:00.000Z',
      expiresAt: '2099-09-15T00:00:00.000Z',
      attestation: { provider: 'test-host', reference: `test-user-request-${context.runId}` },
    });
  },
  verifyExecutionGrant: ({ grant }) => ({ verified: grant.attestation.provider === 'test-host', provider: 'test-host', assertionId: `verified-${grant.grantId}`, observedAt: new Date().toISOString() }),
});

export const makeFixture = async ({ projectId = 'project', profiles = ['feature-delivery'], policy = {}, gateRecipes = [], artifactProviders = [], extensions = [], agentAdapter = null, agentAdapters = {}, executionAuthorizationAdapter = undefined, allowedPluginPermissions = undefined, releaseIdentity = { version: '1.0.0', artifactDigest: null } } = {}) => {
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
    const trustedExecutionAuthorizationAdapter = executionAuthorizationAdapter === undefined ? createTestExecutionAuthorizationAdapter() : executionAuthorizationAdapter;
    const harness = await createHarness({ dataRoot, releaseIdentity, strictProjectIdentity: false, extensions: [...profileExtensions, ...extensions], agentAdapter, agentAdapters, executionAuthorizationAdapter: trustedExecutionAuthorizationAdapter, ...(allowedPluginPermissions ? { allowedPluginPermissions } : {}) });
    const testRuntimeManifest = { id: 'test-runtime', kind: 'agent-runtime', version: '1.0.0', capabilities: ['spawn', 'wait', 'send', 'heartbeat', 'interrupt', 'headless'], permissions: [] };
    harness.registerPlugin(testRuntimeManifest, createInMemoryRuntime({
      manifest: testRuntimeManifest,
      handler: async packet => packet.feature.metadata?.stage === 'quality-repair'
        ? {
            result: {
              status: 'completed',
              summary: 'test repair completed',
              checkpoints: [{ id: 'verification', status: 'passed', summary: 'repair verified', evidence: ['test-runtime'] }],
              changedFiles: [],
            },
            verificationReceipts: [{ id: `verification:${packet.feature.id}`, status: 'passed' }],
          }
        : { status: 'completed', summary: 'test runtime completed', changedFiles: [] },
    }));
    const descriptorInput = { id: projectId, workspace: { root: workspace }, profiles, policy: { agentExecutionMode: 'headless', runtimePlugins: ['test-runtime'], defaultRuntimePlugin: 'test-runtime', promptCodecPlugin: 'reference-agent-prompt-codec', ...policy }, gateRecipes, artifactProviders };
    await harness.projectRegistry.register(descriptorInput, { commandId: `register-${projectId}`, authorityDecision: { actor: 'test-user', decision: 'approved', action: 'project-execution-policy-change', expiresAt: '2099-09-15T00:00:00.000Z', context: projectExecutionPolicyDecisionContext({ input: descriptorInput, expectedRevision: 0 }) } });
    return { root, workspace, dataRoot, harness, projectId, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
};

export const feature = (id, metadata = {}, extra = {}) => ({ id, executionClass: 'agent-reasoning', acceptance: [`${id} accepted`], dependsOn: [], allowedPaths: [`work/${id}`], metadata, ...extra });

export const startRun = async (fixture, { runId = 'run', profileId = 'feature-delivery', features = [feature('one')], profileConfig = {}, artifactDigest = null } = {}) => {
  const output = await fixture.harness.startRun({ projectId: fixture.projectId, runId, profileId, features, profileConfig, artifactDigest, executionAuthorizationEvidence: { explicitUnattended: true } }, command());
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

export const recordResult = async (fixture, runId, dispatch, result = { status: 'completed', summary: 'done', changedFiles: [] }) => fixture.harness.recordResult(fixture.projectId, runId, dispatch.dispatchId, { changedFiles: [], ...result }, { commandId: command().commandId });
