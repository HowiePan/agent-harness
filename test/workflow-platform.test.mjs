import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertSourceManifestCurrent, captureSourceManifest, compileWorkflowFeatures, defineMemorySpace, defineWorkflowDefinition, digestJson, harnessTemporaryRoot, MemoryStore, readPinnedSource, readSourceForDispatch, runWorkflowInstanceSet, searchSourceForDispatch, WorkflowAdmissionStore } from '../src/index.mjs';
import { resolveLifecycleExecutionPolicy } from '../src/platform/plugins/runtime/execution-policy.mjs';
import { composableWorkflowProfile } from '../src/platform/workflow/profiles/composable-workflow.mjs';
import { parsePseudoCommand } from '../integrations/codex/agent-harness-codex/hooks/pseudo-command-router.mjs';

const rootBase = resolve(harnessTemporaryRoot(), 'workflow-platform-tests');
const fixture = async t => {
  await mkdir(rootBase, { recursive: true });
  const root = await mkdtemp(resolve(rootBase, 'case-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

test('workflow compiler validates identity, dependencies, fan-out, and template output', () => {
  assert.throws(() => defineWorkflowDefinition({ id: 'example', version: '1.0.0', profileId: 'composable-workflow', routes: { full: [{ id: 'late', template: 'unit', dependsOn: ['missing'] }] } }), error => error.code === 'WORKFLOW_DEPENDENCY_INVALID');
  const definition = defineWorkflowDefinition({ id: 'example', version: '1.0.0', profileId: 'composable-workflow', routes: { full: [{ id: 'read', template: 'unit', forEach: 'documents' }, { id: 'merge', template: 'unit', dependsOn: ['read'] }] } });
  const templates = { unit: ({ node, item, dependsOn }) => ({ id: `${node.id}/${item ?? 'all'}`, executionClass: 'agent-reasoning', acceptance: ['done'], allowedPaths: [], dependsOn }) };
  const features = compileWorkflowFeatures({ definition, routeId: 'full', templates, context: {}, items: { documents: ['a', 'b'] } });
  assert.deepEqual(features.find(item => item.id === 'merge/all').dependsOn, ['read/a', 'read/b']);
  assert.throws(() => compileWorkflowFeatures({ definition: { ...definition, version: '1.0.1' }, routeId: 'full', templates, context: {}, items: { documents: ['a'] } }), error => error.code === 'WORKFLOW_DIGEST_MISMATCH');
});

test('declarative output checks reject failed review and empty answers', () => {
  const state = { metadata: { memorySnapshot: [] }, profile: { config: { branches: [] } } };
  const review = { metadata: { workflow: { nodeId: 'review' }, outputPorts: { review: 'document-review-v1' }, outputChecks: [{ portId: 'review', path: 'passed', operator: 'equals', value: true }] } };
  assert.equal(composableWorkflowProfile.validateResult({ state, feature: review, result: { outputs: { review: { schemaId: 'document-review-v1', value: { passed: false } } } } }).ok, false);
  const answer = { metadata: { workflow: { nodeId: 'answer' }, outputPorts: { answer: 'qa-answer-v1' }, outputChecks: [{ portId: 'answer', path: 'evidence', operator: 'non-empty' }] } };
  assert.equal(composableWorkflowProfile.validateResult({ state, feature: answer, result: { outputs: { answer: { schemaId: 'qa-answer-v1', value: { claim: 'unsupported', evidence: null } } } } }).ok, false);
});

test('multi-source reads enforce receiver and pinned content', async t => {
  const root = await fixture(t);
  const sourceRoot = resolve(root, 'source');
  await mkdir(sourceRoot);
  await writeFile(resolve(sourceRoot, 'api.mjs'), 'export const api = 1;\n');
  const manifest = await captureSourceManifest({ projectId: 'project', sources: [{ sourceId: 'backend', type: 'repository', root: sourceRoot, allowedReceivers: ['runtime-a'] }] });
  assert.equal((await readPinnedSource(manifest, { sourceId: 'backend', path: 'api.mjs', receiverId: 'runtime-a' })).bytes.toString(), 'export const api = 1;\n');
  const state = { metadata: { sourceManifest: manifest }, dispatches: [{ dispatchId: 'dispatch', status: 'assigned', runtimePluginId: 'runtime-a', featureSnapshot: { metadata: { sourceIds: ['backend'] } } }] };
  const authorityStore = { async read() { return state; } };
  assert.equal((await searchSourceForDispatch({ authorityStore, projectId: 'project', runId: 'run', dispatchId: 'dispatch', query: 'export' })).matches[0].line, 1);
  assert.equal((await readSourceForDispatch({ authorityStore, projectId: 'project', runId: 'run', dispatchId: 'dispatch', sourceId: 'backend', path: 'api.mjs' })).text, 'export const api = 1;\n');
  state.dispatches[0].featureSnapshot.metadata.sourceIds = [];
  await assert.rejects(() => readSourceForDispatch({ authorityStore, projectId: 'project', runId: 'run', dispatchId: 'dispatch', sourceId: 'backend', path: 'api.mjs' }), error => error.code === 'SOURCE_FEATURE_SCOPE_DENIED');
  await assert.rejects(() => readPinnedSource(manifest, { sourceId: 'backend', path: 'api.mjs', receiverId: 'runtime-b' }), error => error.code === 'SOURCE_RECEIVER_DENIED');
  await writeFile(resolve(sourceRoot, 'api.mjs'), 'export const api = 2;\n');
  await assert.rejects(() => assertSourceManifestCurrent(manifest), error => error.code === 'SOURCE_DRIFT');
});

test('memory promotion is submission-bound, idempotent, and invalidates changed dependencies', async t => {
  const root = await fixture(t);
  const evidenceRef = 'evidence:test';
  const authorityStore = { async read() { return { submissions: [{ submissionId: 'submission-1', result: { status: 'completed' }, evidenceRefs: [evidenceRef] }] }; } };
  const memory = new MemoryStore({ controlRoot: process.cwd(), root: resolve(root, 'memory'), authorityStore });
  const space = defineMemorySpace({ scope: 'workflow', domainId: 'domain', projectId: 'project', workflowId: 'example' });
  const sourceRoot = resolve(root, 'source');
  await mkdir(sourceRoot);
  await writeFile(resolve(sourceRoot, 'facts.md'), 'fact\n');
  const manifest = await captureSourceManifest({ projectId: 'project', sources: [{ sourceId: 'doc', type: 'document', root: sourceRoot, allowedReceivers: ['runtime'] }] });
  const dependency = { sourceId: 'doc', path: 'facts.md', contentDigest: manifest.sources[0].files[0].sha256 };
  const proposed = await memory.propose({ space, record: { kind: 'fact', topic: 'topic', claim: 'known fact', dependencies: [dependency], evidenceRef }, commandId: 'propose', expectedRevision: 0 });
  const promoted = await memory.promote({ space, recordId: proposed.result.recordId, projectId: 'project', runId: 'run', submissionId: 'submission-1', verifier: { kind: 'user-confirmed', actor: 'user' }, commandId: 'promote', expectedRevision: 1 });
  assert.equal(promoted.result.status, 'verified');
  assert.equal((await memory.promote({ space, recordId: proposed.result.recordId, projectId: 'project', runId: 'run', submissionId: 'submission-1', verifier: { kind: 'user-confirmed', actor: 'user' }, commandId: 'promote', expectedRevision: 1 })).reused, true);
  assert.equal((await memory.query({ spaces: [space], workflowId: 'example', projectId: 'project', manifest, topic: 'topic' }))[0].validity, 'current');
  const stale = structuredClone(manifest);
  stale.sources[0].files[0].sha256 = digestJson('changed');
  stale.sources[0].contentDigest = digestJson(stale.sources[0].files);
  stale.manifestDigest = digestJson({ schemaVersion: stale.schemaVersion, projectId: stale.projectId, sources: stale.sources });
  assert.equal((await memory.query({ spaces: [space], workflowId: 'example', projectId: 'project', manifest: stale, topic: 'topic' }))[0].validity, 'recheck-required');
  await assert.rejects(() => memory.query({ spaces: [space], workflowId: 'other', projectId: 'project', manifest, topic: 'topic' }), error => error.code === 'MEMORY_SCOPE_DENIED');
  const conflicting = await memory.propose({ space, record: { kind: 'fact', topic: 'topic', claim: 'different fact', dependencies: [dependency], evidenceRef }, commandId: 'conflicting-propose', expectedRevision: 2 });
  assert.deepEqual(conflicting.result.conflictWith, [proposed.result.recordId]);
  await assert.rejects(() => memory.promote({ space, recordId: conflicting.result.recordId, projectId: 'project', runId: 'run', submissionId: 'submission-1', verifier: { kind: 'user-confirmed', actor: 'user' }, commandId: 'conflicting-promote', expectedRevision: 3 }), error => error.code === 'MEMORY_CONFLICT_DECISION_REQUIRED');
  await memory.promote({ space, recordId: conflicting.result.recordId, projectId: 'project', runId: 'run', submissionId: 'submission-1', verifier: { kind: 'user-confirmed', actor: 'user', resolution: 'keep-both' }, commandId: 'conflicting-promote', expectedRevision: 3 });
  assert((await memory.query({ spaces: [space], workflowId: 'example', projectId: 'project', manifest, topic: 'topic' })).every(record => record.validity === 'conflicted'));
  const shared = defineMemorySpace({ scope: 'common', domainId: 'domain', projectId: 'project', memberProjectIds: ['project', 'frontend'] });
  const sharedCandidate = await memory.propose({ space: shared, record: { kind: 'fact', topic: 'topic', claim: 'shared concept', dependencies: [dependency], evidenceRef }, commandId: 'shared-propose', expectedRevision: 0 });
  await memory.promote({ space: shared, recordId: sharedCandidate.result.recordId, projectId: 'project', runId: 'run', submissionId: 'submission-1', verifier: { kind: 'user-confirmed', actor: 'user' }, commandId: 'shared-promote', expectedRevision: 1 });
  const frontendManifest = await captureSourceManifest({ projectId: 'frontend', sources: [{ sourceId: 'doc', type: 'document', root: sourceRoot, allowedReceivers: ['runtime'] }] });
  assert.equal((await memory.query({ spaces: [shared], workflowId: 'example', projectId: 'frontend', manifest: frontendManifest, topic: 'topic' }))[0].validity, 'current');
  await assert.rejects(() => memory.query({ spaces: [shared], workflowId: 'example', projectId: 'outsider', manifest: { ...frontendManifest, projectId: 'outsider' }, topic: 'topic' }), error => ['SOURCE_MANIFEST_DIGEST_MISMATCH', 'MEMORY_SCOPE_DENIED'].includes(error.code));
});

test('Git memory bundles import as unverified and reject forged record identities', async t => {
  const root = await fixture(t);
  const evidenceRef = 'evidence:test';
  const sourceRoot = resolve(root, 'source');
  await mkdir(sourceRoot);
  await writeFile(resolve(sourceRoot, 'facts.md'), 'verified fact\n');
  const manifest = await captureSourceManifest({ projectId: 'project', sources: [{ sourceId: 'doc', type: 'document', root: sourceRoot, allowedReceivers: ['runtime'] }] });
  const dependency = { sourceId: 'doc', path: 'facts.md', contentDigest: manifest.sources[0].files[0].sha256 };
  const candidate = { kind: 'fact', topic: 'topic', claim: 'verified fact', dependencies: [dependency], visibility: 'shared' };
  const authorityStore = { async read() { return { submissions: [{ submissionId: 'submission-1', result: { status: 'completed', outputs: { knowledge: { schemaId: 'memory-candidates-v1', value: { records: [candidate] } } } }, evidenceRefs: [evidenceRef] }] }; } };
  const space = defineMemorySpace({ scope: 'common', domainId: 'domain', projectId: 'project' });
  const original = new MemoryStore({ controlRoot: process.cwd(), root: resolve(root, 'original'), authorityStore });
  const proposed = await original.propose({ space, record: { ...candidate, evidenceRef }, commandId: 'propose', expectedRevision: 0 });
  await original.promote({ space, recordId: proposed.result.recordId, projectId: 'project', runId: 'run', submissionId: 'submission-1', verifier: { kind: 'user-confirmed', actor: 'user' }, commandId: 'promote', expectedRevision: 1 });
  const exported = await original.exportVerified({ space, exportRoot: resolve(root, 'git'), recordIds: [proposed.result.recordId] });
  const imported = new MemoryStore({ controlRoot: process.cwd(), root: resolve(root, 'imported'), authorityStore });
  await imported.importUnverified({ space, bundleFile: exported.file, commandId: 'import', expectedRevision: 0 });
  assert.equal((await imported.read(space)).records[0].status, 'imported-unverified');
  assert.equal((await imported.query({ spaces: [space], workflowId: 'example', projectId: 'project', manifest, topic: 'topic' })).length, 0);
  const staged = await imported.stageFromSubmission({ space, projectId: 'project', runId: 'run', submissionId: 'submission-1', commandId: 'stage', expectedRevision: 1 });
  assert.deepEqual(staged.result.recordIds, [proposed.result.recordId]);
  assert.equal((await imported.read(space)).records[0].status, 'candidate');
  const forged = JSON.parse(await readFile(exported.file, 'utf8'));
  forged.records[0].recordId = digestJson('forged');
  const { bundleDigest: _old, ...body } = forged;
  forged.bundleDigest = digestJson(body);
  const forgedFile = resolve(root, 'git', 'forged.json');
  await writeFile(forgedFile, JSON.stringify(forged));
  await assert.rejects(() => imported.importUnverified({ space, bundleFile: forgedFile, commandId: 'forged', expectedRevision: 2 }), error => error.code === 'MEMORY_IMPORT_RECORD_INVALID');
});

test('multi-workflow pseudo-commands require explicit identity and instance outputs cannot collide', async () => {
  assert.deepEqual(parsePseudoCommand('h:flows project'), { protocolVersion: '1.0', kind: 'flows', projectAlias: 'project' });
  assert.equal(parsePseudoCommand('h:project flow knowledge-qa ask feature-x').workflowId, 'knowledge-qa');
  assert.equal(parsePseudoCommand('h:report project --workflow knowledge-qa').workflowId, 'knowledge-qa');
  const harness = { projectRegistry: { async get() { return { workspace: { root: resolve(process.cwd(), 'synthetic-workspace') } }; } } };
  await assert.rejects(() => runWorkflowInstanceSet({ harness, commandId: 'set', instances: [
    { projectId: 'project', workflowId: 'requirements-design', target: 'a', workflowInput: { outputPaths: { requirements: 'docs/same.md' } } },
    { projectId: 'project', workflowId: 'requirements-design', target: 'b', workflowInput: { outputPaths: { requirements: 'docs/same.md' } } },
  ] }), error => error.code === 'INSTANCE_OUTPUT_CONFLICT');
});

test('durable admission serializes one workspace across independent runner instances', async t => {
  const root = await fixture(t);
  const authorityStore = { async read() { return null; } };
  const first = new WorkflowAdmissionStore({ controlRoot: process.cwd(), root: resolve(root, 'admission'), authorityStore });
  const second = new WorkflowAdmissionStore({ controlRoot: process.cwd(), root: resolve(root, 'admission'), authorityStore });
  const workspaceRoot = resolve(root, 'output');
  await first.enqueue({ requestId: 'first', projectId: 'project', workspaceRoot, outputs: ['docs/a.md'], maxConcurrentRuns: 2 });
  await second.enqueue({ requestId: 'second', projectId: 'project', workspaceRoot, outputs: ['docs/b.md'], maxConcurrentRuns: 2 });
  assert.equal((await first.tryAcquire('first')).acquired, true);
  assert.equal((await second.tryAcquire('second')).acquired, false);
  await first.release('first');
  assert.equal((await second.tryAcquire('second')).acquired, true);
  assert.equal((await first.read()).leases.length, 1);
});

test('workflow-scoped execution policy wins over a same-named action', () => {
  const project = { id: 'project', policy: { agentExecutionMode: 'conversation-visible', defaultRuntimePlugin: 'visible-runtime', runtimePlugins: ['visible-runtime', 'headless-runtime'], actionExecution: { full: { agentExecutionMode: 'conversation-visible', runtimePluginId: 'visible-runtime' }, 'requirements-design.full': { agentExecutionMode: 'headless', runtimePluginId: 'headless-runtime' } } } };
  assert.equal(resolveLifecycleExecutionPolicy({ project, action: 'full', workflowId: 'requirements-design' }).runtimePluginId, 'headless-runtime');
  assert.equal(resolveLifecycleExecutionPolicy({ project, action: 'full', workflowId: 'engine-delivery' }).runtimePluginId, 'visible-runtime');
});
