import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHarness, loadExtensionPack, harnessTemporaryRoot } from '../src/index.mjs';
import { createDeliveryProjectDescriptor } from '../src/flows/delivery-lifecycle/descriptor.mjs';
import { projectExecutionPolicyDecisionContext } from '../src/platform/registry/project-registry.mjs';
import { planApprovalSnapshot } from '../src/flows/delivery-lifecycle/plan-approval.mjs';
import { createMockVisibleHostAdapter } from './test-support.mjs';
import { proposal, completion } from './delivery-batch-support.mjs';

test('native-visible adapter dispatches distinct bounded Agents and executes real checks without an Agent CLI', async t => {
  const controlRoot = resolve(process.cwd());
  const root = await mkdtemp(resolve(harnessTemporaryRoot(), 'bounded-visible-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = resolve(root, 'project');
  await mkdir(resolve(workspaceRoot, '.git'), { recursive: true });
  await mkdir(resolve(workspaceRoot, 'src'));
  await writeFile(resolve(workspaceRoot, 'src/receiver.mjs'), 'export const receive = x => x * 3;');
  await writeFile(resolve(workspaceRoot, 'verify.mjs'), "import assert from 'node:assert/strict'; import {receive} from './src/receiver.mjs'; assert.equal(receive(4),8);");
  const extension = await loadExtensionPack('./src/flows/delivery-lifecycle/index.mjs', { controlRoot });
  const runtime = await loadExtensionPack('./integrations/codex/extensions/codex-runtime.mjs', { controlRoot });
  const packets = new Map(); const spawned = [];
  const adapter = createMockVisibleHostAdapter({ onSpawn: input => { packets.set(input.dispatchId, input.packet); spawned.push(input.packet); },
    onResult: async input => {
      const packet = packets.get(input.dispatchId); const feature = packet.feature;
      const output = (port, schemaId, value) => ({ status: 'completed', summary: 'Observed fixture result.', changedFiles: [],
        outputs: { [port]: { schemaId, value, evidenceRefs: ['fixture:inspection'] } } });
      if (feature.metadata.stage === 'version-planning') return output('plan', 'delivery-plan-v1', { features: ['F01'], proposedFeatures: [proposal()] });
      if (feature.metadata.stage === 'plan-review') return output('plan-review', 'delivery-plan-review-v1', { approved: true, findings: [] });
      if (feature.metadata.deliveryBatch?.id === 'receiver') {
        await writeFile(resolve(workspaceRoot, 'src/receiver.mjs'), 'export const receive = x => x * 2;');
        return completion(feature, ['src/receiver.mjs']);
      }
      if (feature.metadata.deliveryBatch) return completion(feature);
      return { status: 'blocked', summary: 'Fixture intentionally stops after original Feature convergence.', changedFiles: [],
        failureClass: 'external', blocker: { kind: 'external', summary: 'Fixture scope handoff.' } };
    }, onReconcile: async () => ({ ready: true, provider: 'test-host', adapterVersion: '1.0.0',
      contract: { id: 'delivery-batch-test-native', version: '1.0.0', digest: 'd'.repeat(64) },
      assertionId: 'delivery-native-fixture', observedAt: new Date().toISOString(), reconciled: [], issues: [] }) });
  const harness = await createHarness({ controlRoot, dataRoot: resolve(root, 'data'), strictProjectIdentity: false,
    releaseIdentity: { version: '1.0.0', artifactDigest: 'a'.repeat(64), verified: true }, extensions: [extension, runtime], agentAdapter: adapter });
  const descriptor = createDeliveryProjectDescriptor({ id: 'project', workspaceRoot, gateRecipes: [],
    actionPaths: { plan: ['docs'], implement: ['src', 'verify.mjs'], scope: ['docs'] } });
  descriptor.policy.deliveryBatchPolicy = 'bounded-delivery/2';
  descriptor.extensions.find(item => item.id === extension.id).digest = extension.digest;
  descriptor.extensions.find(item => item.id === runtime.id).digest = runtime.digest;
  descriptor.workflows = extension.workflows.map(item => ({ id: item.id, version: item.version,
    artifactDigest: item.artifactDigest, extensionId: extension.id }));
  await harness.projectRegistry.register(descriptor, { commandId: 'register-visible-fixture', authorityDecision: {
    actor: 'test', decision: 'approved', action: 'project-execution-policy-change', expiresAt: '2099-01-01T00:00:00.000Z',
    context: projectExecutionPolicyDecisionContext({ input: descriptor }) } });
  const execute = async action => {
    const plan = await harness.createLifecyclePlan({ projectId: descriptor.id, action, target: 'V1.0.0', extensionId: extension.id, executionWorkspaceRoot: workspaceRoot });
    const preflightReport = await harness.createExecutionReadinessReport(plan);
    assert.equal(preflightReport.executionReady, true, JSON.stringify(preflightReport));
    return harness.executeVisibleLifecyclePlan(plan, { commandId: `fixture-${action}`, preflightReport, maxConcurrency: 1 });
  };
  const planned = await execute('plan');
  assert.equal(planned.reason, 'implementation-plan-user-approval-required');
  const snapshot = planApprovalSnapshot(planned.state);
  const approved = await harness.kernel.recordDecision(descriptor.id, planned.state.runId, {
    id: 'implementation-plan-approved', actor: 'user', decision: 'approved', projectId: descriptor.id,
    runId: planned.state.runId, planDigest: snapshot.planDigest, artifactDigest: snapshot.artifactDigest },
  { expectedRevision: planned.state.revision, commandId: 'fixture-approval' });
  await harness.kernel.closeRun(descriptor.id, approved.state.runId, {}, { expectedRevision: approved.state.revision, commandId: 'fixture-close-plan' });
  const implemented = await execute('implement');
  const deliveries = spawned.filter(packet => packet.feature.metadata.deliveryBatch);
  assert.equal(deliveries.length, 2);
  assert.notEqual(deliveries[0].dispatchId, deliveries[1].dispatchId);
  assert(deliveries.every(packet => packet.execution.runtime.mode === 'conversation-visible'));
  assert(implemented.state.features.filter(feature => feature.metadata.deliveryBatch).every(feature => feature.state === 'completed'));
  assert.equal(implemented.state.features.find(feature => feature.metadata.stage === 'scope-resolution').state, 'blocked');
});
