import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, rmdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { harnessProjectRoot, harnessTemporaryRoot, runWorkflowInstanceSet } from '../src/index.mjs';

const withHarness = async run => {
  const parent = resolve(harnessTemporaryRoot(), 'instance-set');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'case-'));
  try {
    const dataRoot = resolve(root, 'data');
    await mkdir(dataRoot, { recursive: true });
    let counter = 0;
    const harness = {
      controlRoot: harnessProjectRoot(),
      dataRoot,
      authorityStore: { read: async () => null },
      projectRegistry: { get: async id => ({ id, workspace: { root: resolve(root, 'ws'), excluded: [] } }) },
      createLifecyclePlan: async input => {
        counter += 1;
        return { run: { runId: `run-${counter}`, agentExecutionMode: 'headless' }, workflow: { id: input.workflowId }, planDigest: `digest-${counter}` };
      },
      createExecutionReadinessReport: async () => ({ executionReady: true, checks: [] }),
      executeLifecyclePlan: async plan => ({ status: 'closed', state: { runId: plan.run.runId } }),
    };
    return await run({ root, harness });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rmdir(parent).catch(() => {});
    await rmdir(harnessTemporaryRoot()).catch(() => {});
  }
};

const instance = (root, overrides = {}) => ({
  projectId: 'project-a',
  workflowId: 'requirements-design',
  target: 'feature-x',
  executionWorkspaceRoot: resolve(root, 'ws-a'),
  workflowInput: { outputPaths: { requirements: 'docs/requirements.md', design: 'docs/design.md' } },
  ...overrides,
});

test('instance set admits and closes independent Runs and reports a stable set digest', async () => {
  await withHarness(async ({ root, harness }) => {
    const output = await runWorkflowInstanceSet({ harness, commandId: 'set-1', maxConcurrentRuns: 2, instances: [
      instance(root, { instanceKey: 'alpha', executionWorkspaceRoot: resolve(root, 'ws-a') }),
      instance(root, { instanceKey: 'beta', executionWorkspaceRoot: resolve(root, 'ws-b'), workflowInput: { outputPaths: { requirements: 'docs/beta/requirements.md', design: 'docs/beta/design.md' } } }),
    ] });
    assert.equal(output.status, 'closed');
    assert.match(output.setDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual(output.results.map(result => result.instanceKey), ['alpha', 'beta']);
    assert.ok(output.results.every(result => result.status === 'closed'));
  });
});

test('instance set fails closed on invalid, duplicate, conflicting, and over-capacity declarations', async () => {
  await withHarness(async ({ root, harness }) => {
    await assert.rejects(runWorkflowInstanceSet({ harness, commandId: 'set-empty', instances: [] }), error => error.code === 'INSTANCE_SET_INVALID');
    await assert.rejects(runWorkflowInstanceSet({ harness, commandId: 'set-cap', maxConcurrentRuns: 0, instances: [instance(root)] }), error => error.code === 'INSTANCE_CAPACITY_INVALID');
    await assert.rejects(runWorkflowInstanceSet({ harness, commandId: 'set-dupe', instances: [instance(root, { instanceKey: 'same' }), instance(root, { instanceKey: 'same' })] }), error => error.code === 'INSTANCE_KEY_DUPLICATE');
    await assert.rejects(runWorkflowInstanceSet({ harness, commandId: 'set-output', instances: [instance(root, { instanceKey: 'one' }), instance(root, { instanceKey: 'two' })] }), error => error.code === 'INSTANCE_OUTPUT_CONFLICT');
  });
});
