#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { captureSourceManifest, createExecutionAuthorizationAdapter, createHarness, createInMemoryRuntime, defineMemorySpace, digestJson, harnessTemporaryRoot, loadExtensionPack, projectExecutionPolicyDecisionContext, RunCoordinator, runWorkflowInstanceSet, sealLifecycleExecutionGrant } from '../src/index.mjs';
import { createCardWorldProjectDescriptor } from '../src/flows/delivery-lifecycle/index.mjs';
import { createTabletopCollectionProjectDescriptor } from '../src/flows/batch-production/index.mjs';
import { sha256 } from '../src/common/canonical.mjs';

const rootBase = resolve(harnessTemporaryRoot(), 'workflow-canary');
await mkdir(rootBase, { recursive: true });
const root = await mkdtemp(resolve(rootBase, 'run-'));
const within = relative(rootBase, root);
assert(!within.startsWith('..') && !isAbsolute(within));
const workspace = resolve(root, 'output');
const docRoot = resolve(root, 'input-doc');
const docRoot2 = resolve(root, 'input-doc-2');
const repoRoot = resolve(root, 'input-code');
const repoRoot2 = resolve(root, 'input-code-2');
const dataRoot = resolve(root, 'data');
const projectId = 'workflow-canary';
const runtimeId = 'canary-runtime';
const syntheticWorkspaceReadme = '# Synthetic workflow workspace\n';
let harness;
const outputs = [];

const adapter = createExecutionAuthorizationAdapter({
  provider: 'workflow-canary-host', constraints: { processBackedAgent: 'allow-explicit', unattended: 'allow-explicit', decisionLineage: 'command-workflow-canary' },
  authorizeExecution: ({ context, evidence }) => evidence?.explicitUnattended === true ? sealLifecycleExecutionGrant({
    protocolVersion: '1.0', kind: 'lifecycle-execution-grant', grantId: `canary-${context.runId}`, actor: 'canary-command', decision: 'approved', interactionMode: 'unattended', context,
    issuedAt: '2026-09-19T00:00:00.000Z', expiresAt: '2099-09-19T00:00:00.000Z', attestation: { provider: 'workflow-canary-host', reference: 'npm-run-workflow-canary' },
  }) : null,
  verifyExecutionGrant: ({ grant }) => ({ verified: grant.attestation.provider === 'workflow-canary-host', provider: 'workflow-canary-host', assertionId: `verified-${grant.grantId}`, observedAt: new Date().toISOString() }),
});

const sourceText = async (packet, type) => {
  const manifest = packet.workflowContext.sourceManifest;
  const source = manifest.sources.find(item => item.type === type);
  const file = source.files[0];
  const pinned = await harness.readPinnedSourceForDispatch(packet.projectId, packet.runId, packet.dispatchId, source.sourceId, file.path);
  return { text: pinned.bytes.toString('utf8'), ref: `${source.sourceId}/${file.path}#${file.sha256}` };
};
const out = (schemaId, value, evidenceRefs = []) => ({ schemaId, value, evidenceRefs });

const handler = async packet => {
  if (!packet.workflowContext) return { status: 'completed', summary: `Canary completed ${packet.feature.metadata.stage}`, changedFiles: [], ...(packet.feature.metadata.qualityReview ? { findings: [], knownFindingDispositions: [] } : {}) };
  const nodeId = packet.feature.metadata.workflow.nodeId;
  const manifest = packet.workflowContext.sourceManifest;
  const upstream = packet.workflowContext.upstreamOutputs;
  const firstUpstream = Object.values(upstream)[0] ?? {};
  let changedFiles = [];
  let typed = {};
  if (nodeId === 'ingest') {
    const source = manifest.sources.find(item => item.sourceId === packet.feature.metadata.sourceIds[0]);
    const pinned = await harness.readPinnedSourceForDispatch(packet.projectId, packet.runId, packet.dispatchId, source.sourceId, source.files[0].path);
    typed = { facts: out('source-facts-v1', { text: pinned.bytes.toString('utf8'), sourceId: source.sourceId }, [`${source.sourceId}/${source.files[0].path}`]) };
  } else if (nodeId === 'normalize') {
    typed = { requirements: out('requirements-v1', { facts: Object.values(upstream).map(value => value.facts.value.text) }) };
  } else if (nodeId === 'search' && packet.workflowContext.workflow.id === 'requirements-design') {
    const source = manifest.sources.find(item => item.sourceId === packet.feature.metadata.sourceIds[0]);
    const pinned = await harness.readPinnedSourceForDispatch(packet.projectId, packet.runId, packet.dispatchId, source.sourceId, source.files[0].path);
    typed = { code: out('code-evidence-v1', { text: pinned.bytes.toString('utf8'), sourceId: source.sourceId }, [`${source.sourceId}/${source.files[0].path}`]) };
  } else if (nodeId === 'map') {
    typed = { impact: out('impact-map-v1', { code: Object.values(upstream).map(value => value.code.value.text), requirement: 'Feature X' }) };
  } else if (nodeId === 'requirements-doc' || nodeId === 'design-doc') {
    const path = packet.feature.metadata.outputPath;
    const content = nodeId === 'requirements-doc' ? '# Feature X 需求与功能细节\n\n输入：Feature X requires an audit trail.\n\n功能：记录审计事件。\n\n证据：repo/main.mjs。\n' : '# Feature X 设计文档\n\n接口：recordAudit(event)。\n\n数据流：事件进入 audit store。\n\n风险：写入失败需要重试。\n';
    await mkdir(dirname(resolve(workspace, path)), { recursive: true });
    await writeFile(resolve(workspace, path), content, 'utf8');
    changedFiles = [path];
    typed = { document: out('document-ref-v1', { path, sha256: digestJson(content) }) };
  } else if (nodeId === 'review') {
    const paths = Object.values(upstream).map(value => value.document.value.path);
    const requirement = await readFile(resolve(workspace, paths.find(path => path.endsWith('requirements.md'))), 'utf8');
    const design = await readFile(resolve(workspace, paths.find(path => path.endsWith('design.md'))), 'utf8');
    assert(requirement.includes('Feature X') && design.includes('recordAudit'));
    typed = { review: out('document-review-v1', { passed: true, documents: paths }), knowledge: out('memory-candidates-v1', { records: [{ kind: 'fact', topic: 'Feature X', claim: 'Feature X uses recordAudit for audit events.', dependencies: [{ sourceId: 'backend', path: 'main.mjs', contentDigest: manifest.sources.find(source => source.sourceId === 'backend').files[0].sha256 }] }] }) };
  } else if (nodeId === 'parse') {
    typed = { question: out('question-v1', { question: packet.feature.metadata.target, revision: packet.feature.metadata.questionRevision }) };
  } else if (nodeId === 'lookup') {
    typed = { match: out('memory-match-v1', { hit: packet.feature.metadata.expectedHit }) };
  } else if (nodeId === 'search') {
    const source = await sourceText(packet, 'repository');
    typed = { candidate: out('qa-candidate-v1', packet.feature.metadata.target === 'Unknown Y'
      ? { ready: false, claim: null, sourceRef: source.ref }
      : { ready: true, claim: `Feature X uses recordAudit. ${source.text.trim()}`, sourceRef: source.ref }, [source.ref]) };
  } else if (nodeId === 'clarify') {
    typed = { clarification: out('qa-clarification-v1', { missingEvidence: 'No matching symbol in pinned sources.', question: 'Which repository or document defines Unknown Y?' }) };
  } else if (nodeId === 'answer') {
    const memory = packet.workflowContext.memorySnapshot.find(item => item.kind !== 'negative' && item.validity === 'current');
    const rejected = packet.workflowContext.memorySnapshot.some(item => item.kind === 'negative' && item.validity === 'current');
    const claim = rejected ? 'Feature X records audit events through recordAudit with retry handling.' : memory?.claim ?? firstUpstream.candidate?.value.claim ?? 'Unknown';
    typed = { answer: out('qa-answer-v1', { claim, claimFingerprint: digestJson(claim), evidence: memory?.dependencies ?? firstUpstream.candidate?.value.sourceRef ?? null }) };
  } else throw new Error(`Unknown canary node: ${nodeId}`);
  return { status: 'completed', summary: `Canary completed ${nodeId}`, changedFiles, outputs: typed };
};

const runFlow = async ({ workflowId, action, target, workflowInput, commandId }) => {
  const plan = await harness.createLifecyclePlan({ projectId, workflowId, action, target, workflowInput, executionAuthorizationEvidence: { explicitUnattended: true } });
  const preflightReport = await harness.createExecutionReadinessReport(plan);
  assert.equal(preflightReport.executionReady, true, `Preflight failed for ${workflowId}: ${JSON.stringify(preflightReport.checks.filter(check => !check.ready))}`);
  const result = await harness.executeLifecyclePlan(plan, { commandId, preflightReport, maxConcurrency: 1, maxRounds: 30, onGateProgress: () => {} });
  assert.equal(result.status, 'closed', `${workflowId} failed to close: ${result.status}/${result.reason ?? ''}`);
  assert.equal(result.state.status, 'closed');
  assert(result.state.features.every(feature => feature.state === 'completed'));
  outputs.push({ workflowId, runId: result.state.runId, status: result.status, featureCount: result.state.features.length, featureIds: result.state.features.map(feature => feature.id), planDigest: plan.planDigest });
  return result.state;
};

const approve = async (project, runId, decisionId) => {
  const state = await harness.authorityStore.read(project, runId);
  await harness.kernel.recordDecision(project, runId, { id: decisionId, actor: 'canary-command', decision: 'approved' }, { expectedRevision: state.revision, commandId: `canary-decision-${project}-${decisionId}` });
};

const runExistingWorkflows = async ({ engineExtension, collectionExtension }) => {
  const engineWorkspace = resolve(root, 'engine-output');
  const collectionWorkspace = resolve(root, 'collection-output');
  for (const path of [engineWorkspace, collectionWorkspace]) {
    await mkdir(resolve(path, '.git'), { recursive: true });
    await writeFile(resolve(path, 'README.md'), syntheticWorkspaceReadme);
  }
  const engineDescriptor = createCardWorldProjectDescriptor({ id: 'engine-canary', workspaceRoot: engineWorkspace, runtimePluginId: runtimeId, runtimePluginIds: [runtimeId], agentExecutionMode: 'headless', knownFindingInventories: { v1: { version: '1.0', sources: [{ path: 'README.md', sha256: sha256(syntheticWorkspaceReadme) }], findings: [] } } });
  engineDescriptor.gateRecipes = [];
  engineDescriptor.extensions[0].digest = engineExtension.digest;
  engineDescriptor.workflows = [{ id: engineExtension.workflows[0].id, version: engineExtension.workflows[0].version, artifactDigest: engineExtension.workflows[0].artifactDigest, extensionId: engineExtension.id }];
  const collectionDescriptor = createTabletopCollectionProjectDescriptor({ id: 'collection-canary', workspaceRoot: collectionWorkspace, runtimePluginId: runtimeId, runtimePluginIds: [runtimeId], agentExecutionMode: 'headless', batches: [{ id: 'B1', gameIds: ['game-a'], ruleStatus: 'rule-ready' }] });
  collectionDescriptor.gateRecipes = [];
  collectionDescriptor.extensions[0].digest = collectionExtension.digest;
  collectionDescriptor.workflows = [{ id: collectionExtension.workflows[0].id, version: collectionExtension.workflows[0].version, artifactDigest: collectionExtension.workflows[0].artifactDigest, extensionId: collectionExtension.id }];
  for (const descriptor of [engineDescriptor, collectionDescriptor]) await harness.projectRegistry.register(descriptor, { commandId: `canary-register-${descriptor.id}`, authorityDecision: { actor: 'canary-command', decision: 'approved', action: 'project-execution-policy-change', expiresAt: '2099-09-19T00:00:00.000Z', context: projectExecutionPolicyDecisionContext({ input: descriptor, expectedRevision: 0 }) } });
  const coordinator = new RunCoordinator({ harness });
  const enginePlan = await harness.createLifecyclePlan({ projectId: engineDescriptor.id, workflowId: 'engine-delivery', action: 'full', target: 'v1', executionAuthorizationEvidence: { explicitUnattended: true } });
  const enginePreflight = await harness.createExecutionReadinessReport(enginePlan);
  assert.equal(enginePreflight.executionReady, true);
  const engineStart = await harness.startLifecyclePlan(enginePlan, { commandId: 'canary-engine-start', preflightReport: enginePreflight });
  await coordinator.run({ projectId: engineDescriptor.id, runId: engineStart.state.runId, maxRounds: 20 });
  await approve(engineDescriptor.id, engineStart.state.runId, 'canonical-requirement-approved');
  await coordinator.run({ projectId: engineDescriptor.id, runId: engineStart.state.runId, maxRounds: 30 });
  await approve(engineDescriptor.id, engineStart.state.runId, 'user-code-review');
  let state = await harness.authorityStore.read(engineDescriptor.id, engineStart.state.runId);
  assert(state.features.every(feature => feature.state === 'completed'));
  state = (await harness.kernel.closeRun(engineDescriptor.id, state.runId, {}, { expectedRevision: state.revision, commandId: 'canary-engine-close' })).state;
  assert.equal(state.status, 'closed');
  outputs.push({ workflowId: 'engine-delivery', runId: state.runId, status: state.status, featureCount: state.features.length, planDigest: enginePlan.planDigest });

  const collectionPlan = await harness.createLifecyclePlan({ projectId: collectionDescriptor.id, workflowId: 'collection-batch-production', action: 'full', target: 'B1', executionAuthorizationEvidence: { explicitUnattended: true } });
  const collectionPreflight = await harness.createExecutionReadinessReport(collectionPlan);
  assert.equal(collectionPreflight.executionReady, true);
  const collectionStart = await harness.startLifecyclePlan(collectionPlan, { commandId: 'canary-collection-start', preflightReport: collectionPreflight });
  await approve(collectionDescriptor.id, collectionStart.state.runId, 'batch:B1:launched');
  await coordinator.run({ projectId: collectionDescriptor.id, runId: collectionStart.state.runId, maxRounds: 20 });
  for (const decisionId of ['game:game-a:harness-accepted', 'game:game-a:release-review-approved', 'game:game-a:accepted', 'batch:B1:closed']) await approve(collectionDescriptor.id, collectionStart.state.runId, decisionId);
  state = await harness.authorityStore.read(collectionDescriptor.id, collectionStart.state.runId);
  assert(state.features.every(feature => feature.state === 'completed'));
  state = (await harness.kernel.closeRun(collectionDescriptor.id, state.runId, {}, { expectedRevision: state.revision, commandId: 'canary-collection-close' })).state;
  assert.equal(state.status, 'closed');
  outputs.push({ workflowId: 'collection-batch-production', runId: state.runId, status: state.status, featureCount: state.features.length, planDigest: collectionPlan.planDigest });
};

try {
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(docRoot, { recursive: true }), mkdir(docRoot2, { recursive: true }), mkdir(repoRoot, { recursive: true }), mkdir(repoRoot2, { recursive: true })]);
  await writeFile(resolve(workspace, 'README.md'), '# Canary output\n', 'utf8');
  await writeFile(resolve(docRoot, 'feature.md'), 'Feature X requires an audit trail.\n', 'utf8');
  await writeFile(resolve(docRoot2, 'details.md'), 'Feature X must retry failed audit writes.\n', 'utf8');
  await writeFile(resolve(repoRoot, 'main.mjs'), 'export function recordAudit(event) { return event; }\n', 'utf8');
  await writeFile(resolve(repoRoot2, 'client.mjs'), 'export function sendAudit(event) { return recordAudit(event); }\n', 'utf8');
  const manifest = await captureSourceManifest({ projectId, sources: [
    { sourceId: 'requirements', type: 'document', root: docRoot, allowedReceivers: [runtimeId] },
    { sourceId: 'details', type: 'document', root: docRoot2, allowedReceivers: [runtimeId] },
    { sourceId: 'backend', type: 'repository', root: repoRoot, allowedReceivers: [runtimeId] },
    { sourceId: 'frontend', type: 'repository', root: repoRoot2, allowedReceivers: [runtimeId] },
  ] });
  const requirements = await loadExtensionPack('./src/flows/requirements-design/index.mjs', { cwd: process.cwd(), controlRoot: process.cwd() });
  const qa = await loadExtensionPack('./src/flows/knowledge-qa/index.mjs', { cwd: process.cwd(), controlRoot: process.cwd() });
  const workflowProfile = await loadExtensionPack('./src/platform/extensions/composable-workflow.mjs', { cwd: process.cwd(), controlRoot: process.cwd() });
  const engineExtension = await loadExtensionPack('./src/flows/delivery-lifecycle/index.mjs', { cwd: process.cwd(), controlRoot: process.cwd() });
  const collectionExtension = await loadExtensionPack('./src/flows/batch-production/index.mjs', { cwd: process.cwd(), controlRoot: process.cwd() });
  harness = await createHarness({ controlRoot: process.cwd(), dataRoot, releaseIdentity: { version: '1.0.0', artifactDigest: 'a'.repeat(64) }, strictProjectIdentity: false, extensions: [requirements, qa, workflowProfile, engineExtension, collectionExtension], executionAuthorizationAdapter: adapter });
  const runtimeManifest = { id: runtimeId, kind: 'agent-runtime', version: '1.0.0', capabilities: ['spawn', 'wait', 'send', 'heartbeat', 'interrupt', 'headless', 'workspace-shared'], permissions: [] };
  harness.registerPlugin(runtimeManifest, createInMemoryRuntime({ manifest: runtimeManifest, handler }));
  const workflowBindings = [requirements, qa].map(extension => ({ id: extension.workflows[0].id, version: extension.workflows[0].version, artifactDigest: extension.workflows[0].artifactDigest, extensionId: extension.id }));
  const descriptor = { id: projectId, workspace: { root: workspace }, profiles: ['composable-workflow'], extensions: [requirements, qa, workflowProfile].map(extension => ({ id: extension.id, version: extension.version, digest: extension.digest })), workflows: workflowBindings,
    policy: { agentExecutionMode: 'headless', defaultRuntimePlugin: runtimeId, runtimePlugins: [runtimeId], promptCodecPlugin: 'reference-agent-prompt-codec', maxConcurrency: 1 }, gateRecipes: [], artifactProviders: [] };
  await harness.projectRegistry.register(descriptor, { commandId: 'canary-register', authorityDecision: { actor: 'canary-command', decision: 'approved', action: 'project-execution-policy-change', expiresAt: '2099-09-19T00:00:00.000Z', context: projectExecutionPolicyDecisionContext({ input: descriptor, expectedRevision: 0 }) } });
  await runExistingWorkflows({ engineExtension, collectionExtension });
  const requirementsRun = await runFlow({ workflowId: 'requirements-design', action: 'analyze', target: 'feature-x', commandId: 'canary-requirements', workflowInput: { sourceManifest: manifest, outputPaths: { requirements: 'docs/requirements.md', design: 'docs/design.md' } } });
  assert((await readFile(resolve(workspace, 'docs', 'requirements.md'), 'utf8')).includes('Feature X'));
  assert((await readFile(resolve(workspace, 'docs', 'design.md'), 'utf8')).includes('recordAudit'));
  const commonSpace = defineMemorySpace({ scope: 'common', domainId: 'feature-x', projectId });
  const reviewSubmission = requirementsRun.submissions.find(submission => requirementsRun.features.find(feature => feature.id === submission.featureId)?.metadata.workflow.nodeId === 'review');
  const staged = await harness.memoryStore.stageFromSubmission({ space: commonSpace, projectId, runId: requirementsRun.runId, submissionId: reviewSubmission.submissionId, commandId: 'canary-requirements-memory-stage', expectedRevision: 0 });
  await harness.memoryStore.promote({ space: commonSpace, recordId: staged.result.recordIds[0], projectId, runId: requirementsRun.runId, submissionId: reviewSubmission.submissionId, verifier: { kind: 'user-confirmed', actor: 'canary-command' }, commandId: 'canary-requirements-memory-promote', expectedRevision: 1 });
  const set = await runWorkflowInstanceSet({ harness, commandId: 'canary-instance-set', maxConcurrentRuns: 2, instances: [
    { projectId, workflowId: 'requirements-design', action: 'analyze', target: 'feature-y', workflowInput: { sourceManifest: manifest, memorySpaces: [commonSpace], memoryTopic: 'Feature X', outputPaths: { requirements: 'docs/feature-y/requirements.md', design: 'docs/feature-y/design.md' } }, executionAuthorizationEvidence: { explicitUnattended: true } },
    { projectId, workflowId: 'requirements-design', action: 'analyze', target: 'feature-z', workflowInput: { sourceManifest: manifest, memorySpaces: [commonSpace], memoryTopic: 'Feature X', outputPaths: { requirements: 'docs/feature-z/requirements.md', design: 'docs/feature-z/design.md' } }, executionAuthorizationEvidence: { explicitUnattended: true } },
  ] });
  assert.equal(set.status, 'closed', JSON.stringify(set.results));
  for (const entry of set.results) {
    const state = await harness.authorityStore.read(projectId, entry.runId);
    assert.equal(state.status, 'closed');
    assert(state.metadata.memorySnapshot.some(record => record.recordId === staged.result.recordIds[0] && record.validity === 'current'));
  }

  const session = 'session-x';
  const memorySpace = defineMemorySpace({ scope: 'workflow', domainId: 'feature-x', projectId, workflowId: 'knowledge-qa' });
  const sessionSpace = defineMemorySpace({ scope: 'session', domainId: 'feature-x', projectId, workflowId: 'knowledge-qa', sessionId: session });
  const qaInput = questionRevision => ({ sourceManifest: manifest, memorySpaces: [memorySpace, sessionSpace], memoryTopic: 'Feature X', sessionId: session, questionRevision });
  const first = await runFlow({ workflowId: 'knowledge-qa', action: 'ask', target: 'Feature X', commandId: 'canary-qa-miss', workflowInput: qaInput(1) });
  assert(first.features.some(feature => feature.metadata.workflow.nodeId === 'search'));
  const answerSubmission = first.submissions.find(submission => first.features.find(feature => feature.id === submission.featureId)?.metadata.workflow.nodeId === 'answer');
  const claim = answerSubmission.result.outputs.answer.value.claim;
  const record = { kind: 'fact', topic: 'Feature X', claim, dependencies: [{ sourceId: 'backend', path: 'main.mjs', contentDigest: manifest.sources.find(source => source.sourceId === 'backend').files[0].sha256 }], evidenceRef: answerSubmission.evidenceRefs[0] };
  const proposed = await harness.memoryStore.propose({ space: memorySpace, record, commandId: 'canary-memory-propose', expectedRevision: 0 });
  await harness.memoryStore.promote({ space: memorySpace, recordId: proposed.result.recordId, projectId, runId: first.runId, submissionId: answerSubmission.submissionId, verifier: { kind: 'user-confirmed', actor: 'canary-command' }, commandId: 'canary-memory-promote', expectedRevision: 1 });
  const second = await runFlow({ workflowId: 'knowledge-qa', action: 'ask', target: 'Feature X', commandId: 'canary-qa-hit', workflowInput: qaInput(2) });
  assert(!second.features.some(feature => feature.metadata.workflow.nodeId === 'search'), 'Memory hit should skip source search.');
  await harness.memoryStore.rejectAnswer({ space: sessionSpace, claimFingerprint: digestJson(claim), reason: 'Answer rejected for this session', expiresAt: '2099-09-19T00:00:00.000Z', commandId: 'canary-negative', expectedRevision: 0 });
  const third = await runFlow({ workflowId: 'knowledge-qa', action: 'ask', target: 'Feature X', commandId: 'canary-qa-revision', workflowInput: qaInput(3) });
  assert(third.features.some(feature => feature.metadata.workflow.nodeId === 'search'), 'Rejected claim should trigger a new source search.');
  assert(third.submissions.find(submission => third.features.find(feature => feature.id === submission.featureId)?.metadata.workflow.nodeId === 'answer').result.outputs.answer.value.claim !== claim);
  const fourth = await runFlow({ workflowId: 'knowledge-qa', action: 'ask', target: 'Unknown Y', commandId: 'canary-qa-clarify', workflowInput: { ...qaInput(4), memoryTopic: 'Unknown Y' } });
  assert(fourth.features.some(feature => feature.metadata.workflow.nodeId === 'clarify'), 'Missing evidence must produce clarification.');
  assert(!fourth.features.some(feature => feature.metadata.workflow.nodeId === 'answer'), 'Missing evidence must not produce an answer.');
  console.log(JSON.stringify({ ok: true, command: 'npm run workflow:canary', sourceManifestDigest: manifest.manifestDigest, runs: outputs, instanceSet: set, memory: { requirementsPromoted: staged.result.recordIds[0], requirementsReused: true, qaPromoted: proposed.result.recordId, hitSkippedSearch: true, rejectionReopenedSearch: true, missingEvidenceClarified: true }, documents: ['docs/requirements.md', 'docs/design.md'] }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
