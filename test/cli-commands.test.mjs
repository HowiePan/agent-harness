import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { harnessProjectRoot, harnessTemporaryRoot, loadExtensionPack, REFERENCE_MEMORY_PROVIDER, workspaceDecisionContext } from '../src/index.mjs';
import { handleWorkspaceCommand } from '../src/interfaces/cli/commands/workspace.mjs';
import { handleSourceCommand } from '../src/interfaces/cli/commands/source.mjs';
import { handleMemoryCommand } from '../src/interfaces/cli/commands/memory.mjs';

const args = values => name => values[name];
const jsonInput = values => async name => values[name];

const withRoot = async run => {
  const parent = resolve(harnessTemporaryRoot(), 'cli-commands');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'case-'));
  try {
    const dataRoot = resolve(root, 'data');
    const sourceRoot = resolve(root, 'source');
    const targetRoot = resolve(root, 'target');
    await mkdir(dataRoot, { recursive: true });
    await mkdir(sourceRoot, { recursive: true });
    await mkdir(targetRoot, { recursive: true });
    await writeFile(resolve(sourceRoot, 'main.mjs'), 'export const answer = 42;\n', 'utf8');
    await writeFile(resolve(targetRoot, 'README.md'), 'target\n', 'utf8');
    return await run({ root, dataRoot, sourceRoot, targetRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rmdir(parent).catch(() => {});
    await rmdir(harnessTemporaryRoot()).catch(() => {});
  }
};

const descriptor = async ({ sourceRoot, targetRoot }) => {
  const qa = await loadExtensionPack('./src/flows/knowledge-qa/index.mjs', { cwd: process.cwd(), controlRoot: process.cwd() });
  const profile = await loadExtensionPack('./src/platform/extensions/composable-workflow.mjs', { cwd: process.cwd(), controlRoot: process.cwd() });
  const workflow = qa.workflows[0];
  return {
    schemaVersion: '1.0', workspaceId: 'atlas', alias: 'atlas', profiles: ['composable-workflow'],
    extensions: [qa, profile].map(extension => ({ id: extension.id, version: extension.version, digest: extension.digest })),
    workflows: [{ id: workflow.id, version: workflow.version, artifactDigest: workflow.artifactDigest, extensionId: qa.id, profileId: workflow.profileId, allowedProjectIds: ['member'], defaultProjectScope: ['member'], executionTargetId: 'analysis' }],
    projects: [{ id: 'member', sourceIds: ['front'], executionTargetIds: ['analysis'] }],
    sources: [{ sourceId: 'front', type: 'repository', root: sourceRoot, ownerProjectId: 'member', allowedReceivers: ['test-runtime'] }],
    executionTargets: [{ id: 'analysis', root: targetRoot, projectIds: ['member'] }],
    resources: [{ id: 'common', kind: 'memory', scope: 'workspace', providerRef: REFERENCE_MEMORY_PROVIDER, readProjectIds: ['member'], writeProjectIds: ['member'] }],
    policy: { agentExecutionMode: 'headless', defaultRuntimePlugin: 'test-runtime', runtimePlugins: ['test-runtime'], promptCodecPlugin: 'reference-agent-prompt-codec', maxConcurrency: 1 }, gateRecipes: [], artifactProviders: [],
  };
};

test('workspace CLI handler lists, registers, and shows a Workspace', async () => {
  await withRoot(async ({ dataRoot, sourceRoot, targetRoot }) => {
    const controlRoot = harnessProjectRoot();
    const input = await descriptor({ sourceRoot, targetRoot });
    assert.equal(await handleWorkspaceCommand({ subject: 'unknown', dataRoot, controlRoot, take: args({}), jsonFile: jsonInput({}), jsonInput: jsonInput({}) }), false);
    const listed = await handleWorkspaceCommand({ subject: 'list', dataRoot, controlRoot, take: args({}), jsonFile: jsonInput({}), jsonInput: jsonInput({}) });
    assert.equal(listed, true);
    const decision = { actor: 'test', decision: 'approved', action: 'workspace-register', expiresAt: '2099-01-01T00:00:00.000Z', context: workspaceDecisionContext({ input }) };
    assert.equal(await handleWorkspaceCommand({ subject: 'register', dataRoot, controlRoot, take: args({ '--command-id': 'cli-register', '--decision': 'decision.json' }), jsonFile: jsonInput({ 'decision.json': decision }), jsonInput: jsonInput({ '--input': input }) }), true);
    assert.equal(await handleWorkspaceCommand({ subject: 'show', dataRoot, controlRoot, take: args({ '--workspace-id': 'atlas' }), jsonFile: jsonInput({}), jsonInput: jsonInput({}) }), true);
  });
});

test('source CLI handler captures a manifest and rejects unknown subjects', async () => {
  await withRoot(async ({ dataRoot, sourceRoot }) => {
    const controlRoot = harnessProjectRoot();
    assert.equal(await handleSourceCommand({ subject: 'unknown', runDataRoot: dataRoot, controlRoot, dataRoot, take: args({}), optionalNumber: () => undefined, jsonInput: jsonInput({}) }), false);
    const captured = await handleSourceCommand({
      subject: 'capture', runDataRoot: dataRoot, controlRoot, dataRoot, take: args({}), optionalNumber: () => undefined,
      jsonInput: jsonInput({ '--input': { projectId: 'member', sources: [{ sourceId: 'front', type: 'repository', root: sourceRoot }] } }),
    });
    assert.equal(captured, true);
  });
});

test('memory CLI handler recovers pending promotions and rejects unknown subjects', async () => {
  await withRoot(async ({ dataRoot }) => {
    const controlRoot = harnessProjectRoot();
    const recovered = await handleMemoryCommand({ subject: 'recover', runDataRoot: dataRoot, controlRoot, take: args({}), optionalNumber: () => undefined, jsonInput: jsonInput({}) });
    assert.equal(recovered, true);
    await assert.rejects(handleMemoryCommand({ subject: 'bogus', runDataRoot: dataRoot, controlRoot, take: args({}), optionalNumber: () => undefined, jsonInput: jsonInput({ '--input': {} }) }), error => error.code === 'COMMAND_UNKNOWN');
  });
});
