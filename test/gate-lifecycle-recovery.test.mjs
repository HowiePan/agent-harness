import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHarness } from '../src/application/harness.mjs';
import { createCardWorldProjectDescriptor } from '../integrations/legacy-consumers/cardworld/index.mjs';
import { loadExtensionPack } from '../src/platform/extensions/contract.mjs';
import { createInMemoryRuntime } from '../src/platform/plugins/runtime/in-memory-runtime.mjs';
import { harnessTemporaryRoot } from '../src/common/write-boundary.mjs';
import { createTestExecutionAuthorizationAdapter } from './test-support.mjs';
import { projectExecutionPolicyDecisionContext } from '../src/platform/registry/project-registry.mjs';
import { sha256 } from '../src/common/canonical.mjs';

test('a failed final Gate returns attention and a fresh retry closes the same quality Run', async t => {
  const controlRoot = resolve(process.cwd());
  const parent = resolve(harnessTemporaryRoot(), 'gate-lifecycle-recovery');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'case-'));
  const workspace = resolve(root, 'CardWorld');
  const dataRoot = resolve(root, 'data');
  const passFlag = resolve(dataRoot, 'allow-gate-pass');
  await mkdir(resolve(workspace, '.git'), { recursive: true });
  await writeFile(resolve(workspace, 'README.md'), '# Gate recovery fixture\n', 'utf8');
  t.after(() => rm(root, { recursive: true, force: true }));

  const engine = await loadExtensionPack('./integrations/legacy-consumers/cardworld/index.mjs', { cwd: controlRoot, controlRoot });
  const releaseIdentity = { version: '1.0.0', artifactDigest: 'a'.repeat(64), verified: true };
  const harness = await createHarness({ controlRoot, dataRoot, releaseIdentity, strictProjectIdentity: false, extensions: [engine], executionAuthorizationAdapter: createTestExecutionAuthorizationAdapter() });
  const runtimeManifest = { id: 'gate-test-runtime', kind: 'agent-runtime', version: '1.0.0', capabilities: ['spawn', 'wait', 'headless'], permissions: [] };
  harness.registerPlugin(runtimeManifest, createInMemoryRuntime({ manifest: runtimeManifest, handler: async () => ({ status: 'completed', summary: 'quality review clean', changedFiles: [], findings: [], knownFindingDispositions: [] }) }));
  const descriptor = createCardWorldProjectDescriptor({ workspaceRoot: workspace, harness: releaseIdentity, runtimePluginId: runtimeManifest.id, runtimeExtension: null, agentExecutionMode: 'headless', knownFindingInventories: { 'V3.8.4': { version: '1.0', sources: [{ path: 'README.md', sha256: sha256('# Gate recovery fixture\n') }], findings: [] } } });
  descriptor.extensions = descriptor.extensions.map(item => ({ ...item, digest: engine.digest }));
  descriptor.gateRecipes = [{
    id: 'quality-gate',
    executionClass: 'deterministic-process',
    scope: 'final',
    required: true,
    forceFresh: true,
    command: [process.execPath, '-e', "process.exit(require('node:fs').existsSync(process.argv[1]) ? 0 : 2)", passFlag],
    cwd: '.',
  }];
  await harness.projectRegistry.register(descriptor, { expectedRevision: 0, commandId: 'gate-recovery-project', authorityDecision: { actor: 'test-user', decision: 'approved', action: 'project-execution-policy-change', expiresAt: '2099-09-15T00:00:00.000Z', context: projectExecutionPolicyDecisionContext({ input: descriptor, expectedRevision: 0 }) } });
  const plan = await harness.createLifecyclePlan({ projectId: descriptor.id, action: 'quality', target: 'V3.8.4', arguments: ['full'], extensionId: engine.id, executionWorkspaceRoot: workspace, executionAuthorizationEvidence: { explicitUnattended: true } });
  const progress = () => {};
  const firstPreflight = await harness.createExecutionReadinessReport(plan, { onGateProgress: progress });
  assert.equal(firstPreflight.executionReady, true);
  const failed = await harness.executeLifecyclePlan(plan, { commandId: 'quality-gate-first', preflightReport: firstPreflight, onGateProgress: progress });
  assert.equal(failed.status, 'attention-required');
  assert.equal(failed.reason, 'final-gates-not-passed');
  assert.equal(failed.gates.results[0].status, 'failed');
  assert.notEqual(failed.state.status, 'closed');

  await writeFile(passFlag, 'pass\n', 'utf8');
  const retryPreflight = await harness.createExecutionReadinessReport(plan, { onGateProgress: progress });
  assert.equal(retryPreflight.executionReady, true);
  const completed = await harness.executeLifecyclePlan(plan, { commandId: 'quality-gate-retry', preflightReport: retryPreflight, onGateProgress: progress });
  assert.equal(completed.status, 'closed');
  assert.equal(completed.gates.results[0].status, 'passed');
  assert.equal(completed.state.runId, failed.state.runId);
});
