import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WorkspaceRegistry, workspaceDecisionContext, workspaceProjectionId, REFERENCE_MEMORY_PROVIDER, createHarness, loadExtensionPack, createInMemoryRuntime, harnessTemporaryRoot } from '../src/index.mjs';

const fixture = async () => {
  const root = await mkdtemp(resolve(harnessTemporaryRoot(), 'workspace-test-'));
  const dataRoot = resolve(root, 'data');
  const targetRoot = resolve(root, 'output');
  const sourceRoot = resolve(root, 'source');
  await mkdir(targetRoot, { recursive: true });
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(resolve(targetRoot, 'README.md'), 'workspace output\n');
  await writeFile(resolve(sourceRoot, 'main.mjs'), 'export const answer = 42;\n');
  const qa = await loadExtensionPack('./src/consumers/knowledge-qa.mjs', { cwd: process.cwd(), controlRoot: process.cwd() });
  const profile = await loadExtensionPack('./src/extensions/composable-workflow.mjs', { cwd: process.cwd(), controlRoot: process.cwd() });
  const workflow = qa.workflows[0];
  const descriptor = {
    schemaVersion: '1.0', workspaceId: 'atlas', alias: 'atlas', profiles: ['composable-workflow'],
    extensions: [qa, profile].map(extension => ({ id: extension.id, version: extension.version, digest: extension.digest })),
    workflows: [{ id: workflow.id, version: workflow.version, artifactDigest: workflow.artifactDigest, extensionId: qa.id, profileId: workflow.profileId, allowedProjectIds: ['frontend', 'backend'], defaultProjectScope: ['frontend', 'backend'], executionTargetId: 'analysis' }],
    projects: [{ id: 'frontend', sourceIds: ['front'], executionTargetIds: ['analysis'] }, { id: 'backend', sourceIds: ['back'], executionTargetIds: ['analysis'] }],
    sources: [{ sourceId: 'front', type: 'repository', root: sourceRoot, ownerProjectId: 'frontend', allowedReceivers: ['test-runtime'] }, { sourceId: 'back', type: 'repository', root: sourceRoot, ownerProjectId: 'backend', allowedReceivers: ['test-runtime'] }],
    executionTargets: [{ id: 'analysis', root: targetRoot, projectIds: ['frontend', 'backend'] }],
    resources: [{ id: 'common', kind: 'memory', scope: 'workspace', providerRef: REFERENCE_MEMORY_PROVIDER, readProjectIds: ['frontend', 'backend'], writeProjectIds: ['frontend', 'backend'] }],
    policy: { agentExecutionMode: 'headless', defaultRuntimePlugin: 'test-runtime', runtimePlugins: ['test-runtime'], promptCodecPlugin: 'reference-agent-prompt-codec', maxConcurrency: 1 }, gateRecipes: [], artifactProviders: [],
  };
  return { root, dataRoot, descriptor, qa, profile };
};

test('Workspace Registry owns identity, revisions, aliases and Project projections', async () => {
  const { root, dataRoot, descriptor } = await fixture();
  try {
    const registry = new WorkspaceRegistry({ root: dataRoot, controlRoot: process.cwd() });
    const approve = (input, current = null) => ({ actor: 'test', decision: 'approved', action: 'workspace-register', expiresAt: '2099-01-01T00:00:00.000Z', context: workspaceDecisionContext({ current, input }) });
    const first = await registry.register(descriptor, { commandId: 'register-1', authorityDecision: approve(descriptor) });
    assert.equal(first.revision, 1);
    assert.equal((await registry.resolveAlias('atlas')).workspaceId, 'atlas');
    assert.deepEqual(await registry.register(descriptor, { commandId: 'register-1', authorityDecision: approve(descriptor) }), first);
    const changed = { ...descriptor, alias: 'atlas-new' };
    const second = await registry.register(changed, { expectedRevision: 1, commandId: 'register-2', authorityDecision: approve(changed, first) });
    assert.equal(second.revision, 2);
    assert.notEqual(second.descriptorDigest, first.descriptorDigest);
    await assert.rejects(registry.register(descriptor, { expectedRevision: 1, commandId: 'stale', authorityDecision: approve(descriptor, first) }), { code: 'WORKSPACE_REVISION_CONFLICT' });
    const projectId = workspaceProjectionId('atlas', 'analysis');
    assert.equal(projectId, 'ws.atlas.analysis');
    const harness = await createHarness({ controlRoot: process.cwd(), dataRoot, workspaceId: 'atlas', releaseIdentity: { version: '1.0.0', artifactDigest: 'a'.repeat(64) }, strictProjectIdentity: false });
    const projection = await harness.projectRegistry.get(projectId);
    assert.equal(projection.revision, 2);
    assert.equal(projection.workflows[0].id, 'knowledge-qa');
    await assert.rejects(harness.projectRegistry.register({ ...projection }, { commandId: 'denied' }), { code: 'WORKSPACE_PROJECT_REGISTRATION_DENIED' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Workspace planning derives Source Manifest and memory bindings from approved configuration', async () => {
  const { root, dataRoot, descriptor, qa, profile } = await fixture();
  try {
    const registry = new WorkspaceRegistry({ root: dataRoot, controlRoot: process.cwd() });
    await registry.register(descriptor, { commandId: 'register', authorityDecision: { actor: 'test', decision: 'approved', action: 'workspace-register', expiresAt: '2099-01-01T00:00:00.000Z', context: workspaceDecisionContext({ input: descriptor }) } });
    const harness = await createHarness({ controlRoot: process.cwd(), dataRoot, workspaceId: 'atlas', releaseIdentity: { version: '1.0.0', artifactDigest: 'a'.repeat(64) }, strictProjectIdentity: false, extensions: [qa, profile] });
    const manifest = { id: 'test-runtime', kind: 'agent-runtime', version: '1.0.0', capabilities: ['spawn', 'wait', 'send', 'heartbeat', 'interrupt', 'headless', 'workspace-shared'], permissions: [] };
    harness.registerPlugin(manifest, createInMemoryRuntime({ manifest, handler: async () => ({ status: 'completed', summary: 'done', changedFiles: [] }) }));
    const plan = await harness.createWorkspaceLifecyclePlan({ workspaceId: 'atlas', workflowId: 'knowledge-qa', action: 'ask', target: 'What is answer?', workflowInput: { sessionId: 's1', questionRevision: 1 } });
    assert.equal(plan.workspaceRef.workspaceId, 'atlas');
    assert.deepEqual(plan.workspaceRef.projectIds, ['backend', 'frontend']);
    assert.deepEqual(plan.intent.workflowInput.sourceManifest.sources.map(source => source.sourceId), ['back', 'front']);
    assert.equal(plan.intent.workflowInput.memorySpaces.length, 1);
    assert.equal(plan.run.metadata.workspaceRef.descriptorDigest, plan.workspaceRef.descriptorDigest);
    await writeFile(resolve(root, 'source', 'main.mjs'), 'export const answer = 43;\n');
    const changedPlan = await harness.createWorkspaceLifecyclePlan({ workspaceId: 'atlas', workflowId: 'knowledge-qa', action: 'ask', target: 'What changed?', workflowInput: { sessionId: 's1', questionRevision: 2 } });
    assert.notEqual(changedPlan.intent.workflowInput.sourceManifest.sourceSetDigest, plan.intent.workflowInput.sourceManifest.sourceSetDigest, 'Full-source coverage must be invalidated by content changes even when the configured sources stay the same.');
    await assert.rejects(harness.createLifecyclePlan({ projectId: 'ws.atlas.analysis', workflowId: 'knowledge-qa', action: 'ask', target: 'bypass' }), { code: 'WORKSPACE_PLAN_ENTRY_REQUIRED' });
    await assert.rejects(harness.createWorkspaceLifecyclePlan({ workspaceId: 'atlas', workflowId: 'knowledge-qa', action: 'ask', target: 'bypass', workflowInput: { sourceManifest: plan.intent.workflowInput.sourceManifest } }), { code: 'WORKSPACE_MANAGED_INPUT_DENIED' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
