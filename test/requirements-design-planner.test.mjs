import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { captureSourceManifest, harnessTemporaryRoot } from '../src/index.mjs';
import { createRequirementsDesignPlan } from '../src/flows/requirements-design/planner.mjs';

const project = { id: 'planner-project', policy: { agentExecutionMode: 'headless', defaultRuntimePlugin: 'runtime-x', runtimePlugins: ['runtime-x'] }, gateRecipes: [] };

const withSources = async run => {
  const parent = resolve(harnessTemporaryRoot(), 'requirements-planner');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'case-'));
  try {
    const docRoot = resolve(root, 'docs');
    const repoRoot = resolve(root, 'repo');
    await mkdir(docRoot, { recursive: true });
    await mkdir(repoRoot, { recursive: true });
    await writeFile(resolve(docRoot, 'feature.md'), 'Feature X requires an audit trail.\n', 'utf8');
    await writeFile(resolve(repoRoot, 'main.mjs'), 'export const recordAudit = event => event;\n', 'utf8');
    return await run({ docRoot, repoRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rmdir(parent).catch(() => {});
    await rmdir(harnessTemporaryRoot()).catch(() => {});
  }
};

const intent = (manifest, outputPaths) => ({ action: 'analyze', workflowId: 'requirements-design', target: 'feature-x', workflowInput: { sourceManifest: manifest, outputPaths } });

test('requirements planner compiles document and repository sources into the analyze route', async () => {
  await withSources(async ({ docRoot, repoRoot }) => {
    const manifest = await captureSourceManifest({ projectId: project.id, sources: [
      { sourceId: 'requirements', type: 'document', root: docRoot, allowedReceivers: ['runtime-x'] },
      { sourceId: 'backend', type: 'repository', root: repoRoot, allowedReceivers: ['runtime-x'] },
    ] });
    const plan = createRequirementsDesignPlan({ intent: intent(manifest, { requirements: 'docs/requirements.md', design: 'docs/design.md' }), project, runId: 'run-analyze' });
    assert.equal(plan.run.profileId, 'composable-workflow');
    assert.equal(plan.run.runId, 'run-analyze');
    assert.equal(plan.run.metadata.workflow.id, 'requirements-design');
    assert.equal(plan.run.metadata.instanceKey, 'feature-x');
    assert.ok(plan.run.features.length > 0);
    assert.equal(plan.stopCondition.type, 'workflow-complete');
    assert.deepEqual(plan.protectedOperations, ['publication', 'commit', 'push', 'external-cutover']);
  });
});

test('requirements planner selects the code-only route without documents', async () => {
  await withSources(async ({ docRoot, repoRoot }) => {
    const manifest = await captureSourceManifest({ projectId: project.id, sources: [
      { sourceId: 'backend', type: 'repository', root: repoRoot, allowedReceivers: ['runtime-x'] },
      { sourceId: 'extra', type: 'document', root: docRoot, allowedReceivers: ['runtime-x'] },
    ] });
    const plan = createRequirementsDesignPlan({ intent: intent(manifest, { requirements: 'docs/r.md', design: 'docs/d.md' }), project, runId: 'run-code' });
    assert.ok(plan.run.features.some(feature => feature.metadata?.stage === 'code-discovery' || feature.id.includes('architecture') || feature.id.includes('map')));
  });
});

test('requirements planner fails closed on invalid sources, receivers, and outputs', async () => {
  await withSources(async ({ docRoot, repoRoot }) => {
    const documentOnly = await captureSourceManifest({ projectId: project.id, sources: [{ sourceId: 'requirements', type: 'document', root: docRoot, allowedReceivers: ['runtime-x'] }] });
    assert.throws(() => createRequirementsDesignPlan({ intent: intent(documentOnly, { requirements: 'docs/r.md', design: 'docs/d.md' }), project, runId: 'run-1' }), error => error.code === 'WORKFLOW_SOURCE_KIND_REQUIRED');

    const denied = await captureSourceManifest({ projectId: project.id, sources: [{ sourceId: 'backend', type: 'repository', root: repoRoot }] });
    assert.throws(() => createRequirementsDesignPlan({ intent: intent(denied, { requirements: 'docs/r.md', design: 'docs/d.md' }), project, runId: 'run-2' }), error => error.code === 'SOURCE_RECEIVER_DENIED');

    const valid = await captureSourceManifest({ projectId: project.id, sources: [{ sourceId: 'backend', type: 'repository', root: repoRoot, allowedReceivers: ['runtime-x'] }] });
    assert.throws(() => createRequirementsDesignPlan({ intent: intent(valid, { requirements: 'docs/same.md', design: 'docs/same.md' }), project, runId: 'run-3' }), error => error.code === 'WORKFLOW_OUTPUT_CONFLICT');
    assert.throws(() => createRequirementsDesignPlan({ intent: { action: 'analyze', workflowId: 'requirements-design', target: 'x' }, project, runId: 'run-4' }), error => error.code === 'WORKFLOW_INPUT_REQUIRED');
  });
});
