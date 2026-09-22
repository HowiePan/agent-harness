#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createExecutionAuthorizationAdapter, createHarness, createInMemoryRuntime, defineMemorySpace, digestJson, harnessTemporaryRoot, loadExtensionPack, REFERENCE_MEMORY_PROVIDER, RunCoordinator, sealLifecycleExecutionGrant, workspaceDecisionContext, workspaceFromProjectDescriptor, WorkspaceRegistry } from '../src/index.mjs';
import { parsePseudoCommand } from '../integrations/codex/agent-harness-codex/hooks/pseudo-command-router.mjs';
import { createCardWorldProjectDescriptor } from '../integrations/legacy-consumers/cardworld/index.mjs';
import { createTabletopCollectionProjectDescriptor } from '../integrations/legacy-consumers/collection/index.mjs';
import { sha256 } from '../src/common/canonical.mjs';

// Exercise the legacy Engine and Collection closure path in the same command Gate.
await import('./workflow-canary.mjs');

const root = await mkdtemp(resolve(harnessTemporaryRoot(), 'workspace-canary-'));
const dataRoot = resolve(root, 'data');
const runtimeId = 'workspace-canary-runtime';
const legacyWorkspaceReadme = 'Canary output\n';
const harnesses = new Map();
const outputRoots = new Map();
const runs = [];
const out = (schemaId, value, evidenceRefs = []) => ({ schemaId, value, evidenceRefs });
const legacyWorkflowOutputs = Object.freeze({
  'engine-delivery': Object.freeze({
    intake: ['intake', 'delivery-intake-v1', { requirements: ['Synthetic workspace requirement.'] }],
    canonical: ['canonical', 'canonical-requirement-v1', { id: 'workspace-requirement', acceptance: ['Synthetic acceptance is satisfied.'] }],
    plan: ['plan', 'delivery-plan-v1', { features: ['synthetic-feature'] }],
    implement: ['implement', 'delivery-implementation-v1', { changedFiles: [] }],
    scope: ['scope', 'delivery-scope-v1', { resolved: true }],
    docs: ['docs', 'delivery-docs-v1', { documents: ['README.md'] }],
    quality: ['quality', 'delivery-quality-v1', { findings: [] }],
    review: ['review', 'delivery-review-v1', { approved: true }],
    deliver: ['deliver', 'delivery-receipt-v1', { receiptId: 'workspace-delivery', status: 'closed' }],
  }),
  'collection-batch-production': Object.freeze({
    rules: ['rules', 'batch-rules-v1', { ready: true }],
    produce: ['produce', 'batch-produce-v1', { changedFiles: [] }],
    quality: ['quality', 'batch-quality-v1', { findings: [] }],
    review: ['review', 'batch-review-v1', { reviewed: true }],
    accept: ['accept', 'batch-accept-v1', { accepted: true }],
    launch: ['launch', 'batch-launch-v1', { launched: true }],
    close: ['close', 'batch-close-v1', { closed: true }],
  }),
});
const adapter = createExecutionAuthorizationAdapter({
  provider: 'workspace-canary-host', constraints: { processBackedAgent: 'allow-explicit', unattended: 'allow-explicit', decisionLineage: 'workspace-canary-command' },
  authorizeExecution: ({ context, evidence }) => evidence?.explicitUnattended === true ? sealLifecycleExecutionGrant({ protocolVersion: '1.0', kind: 'lifecycle-execution-grant', grantId: `workspace-canary-${context.runId}`, actor: 'workspace-canary', decision: 'approved', interactionMode: 'unattended', context, issuedAt: '2026-09-19T00:00:00.000Z', expiresAt: '2099-09-19T00:00:00.000Z', attestation: { provider: 'workspace-canary-host', reference: 'npm-run-workspace-canary' } }) : null,
  verifyExecutionGrant: ({ grant }) => ({ verified: grant.attestation.provider === 'workspace-canary-host', provider: 'workspace-canary-host', assertionId: `verified-${grant.grantId}`, observedAt: new Date().toISOString() }),
});

const handler = async packet => {
  const workspaceId = packet.projectId.split('.')[1];
  const harness = harnesses.get(workspaceId);
  const outputRoot = outputRoots.get(workspaceId);
  const context = packet.workflowContext;
  if (!context) return { status: 'completed', summary: `Workspace Canary ${packet.feature.metadata.stage}`, changedFiles: [], ...(packet.feature.metadata.qualityReview ? { findings: [], knownFindingDispositions: [] } : {}) };
  const nodeId = packet.feature.metadata.workflow.nodeId;
  const legacyDefinition = legacyWorkflowOutputs[context.workflow.id]?.[nodeId];
  if (legacyDefinition) {
    const [port, schemaId, value] = legacyDefinition;
    return {
      status: 'completed',
      summary: `Workspace Canary ${nodeId}`,
      changedFiles: [],
      outputs: { [port]: out(schemaId, value, [`workspace-canary/${nodeId}`]) },
      ...(nodeId === 'quality' ? { findings: [], knownFindingDispositions: [] } : {}),
    };
  }
  const manifest = context.sourceManifest;
  const upstream = context.upstreamOutputs;
  let outputs = {};
  let changedFiles = [];
  const pinned = async source => {
    const file = source.files[0];
    const result = await harness.readPinnedSourceForDispatch(packet.projectId, packet.runId, packet.dispatchId, source.sourceId, file.path);
    return { text: result.bytes.toString('utf8'), ref: `${source.sourceId}/${file.path}`, file };
  };
  if (nodeId === 'brief') {
    const sources = await Promise.all(manifest.sources.map(source => pinned(source)));
    const path = packet.feature.metadata.outputPath;
    const content = `# Audit Trail source brief\n\n${sources.map(source => `- ${source.ref}: ${source.text.trim()}`).join('\n')}\n`;
    await mkdir(dirname(resolve(outputRoot, path)), { recursive: true });
    await writeFile(resolve(outputRoot, path), content);
    changedFiles = [path];
    outputs = { document: out('document-ref-v1', { path, sha256: digestJson(content) }, sources.map(source => source.ref)) };
  } else if (nodeId === 'ingest') {
    const source = manifest.sources.find(item => item.sourceId === packet.feature.metadata.sourceIds[0]);
    const read = await pinned(source);
    outputs = { facts: out('source-facts-v1', { text: read.text, sourceId: source.sourceId }, [read.ref]) };
  } else if (nodeId === 'normalize') {
    outputs = { requirements: out('requirements-v1', { facts: Object.values(upstream).map(value => value.facts.value.text) }) };
  } else if (nodeId === 'search' && context.workflow.id === 'requirements-design') {
    const source = manifest.sources.find(item => item.sourceId === packet.feature.metadata.sourceIds[0]);
    const read = await pinned(source);
    outputs = { code: out('code-evidence-v1', { text: read.text, sourceId: source.sourceId }, [read.ref]) };
  } else if (nodeId === 'map') {
    outputs = { impact: out('impact-map-v1', { code: Object.values(upstream).map(value => value.code.value.text), requirement: 'Audit Trail' }) };
  } else if (nodeId === 'requirements-doc' || nodeId === 'design-doc') {
    const path = packet.feature.metadata.outputPath;
    const content = nodeId === 'requirements-doc' ? '# Audit Trail 需求与功能细节\n\n审计事件必须持久化，并在失败时重试。\n' : '# Audit Trail 设计文档\n\n前端调用 sendAudit，后端执行 recordAudit。\n';
    await mkdir(dirname(resolve(outputRoot, path)), { recursive: true });
    await writeFile(resolve(outputRoot, path), content);
    changedFiles = [path];
    outputs = { document: out('document-ref-v1', { path, sha256: digestJson(content) }) };
  } else if (nodeId === 'review') {
    const paths = Object.values(upstream).map(value => value.document.value.path);
    for (const path of paths) assert((await readFile(resolve(outputRoot, path), 'utf8')).includes('Audit Trail'));
    const common = manifest.sources.find(source => source.sourceId.endsWith('common'));
    outputs = { review: out('document-review-v1', { passed: true, documents: paths }), knowledge: out('memory-candidates-v1', { records: [{ kind: 'fact', topic: 'Audit Trail', claim: 'Audit Trail requires durable audit events and retry.', dependencies: [{ sourceId: common.sourceId, path: common.files[0].path, contentDigest: common.files[0].sha256 }] }] }) };
  } else if (nodeId === 'parse') {
    outputs = { question: out('question-v1', { question: packet.feature.metadata.target, revision: packet.feature.metadata.questionRevision }) };
  } else if (nodeId === 'lookup') {
    outputs = { match: out('memory-match-v1', { hit: packet.feature.metadata.expectedHit }) };
  } else if (nodeId === 'search') {
    const source = manifest.sources.find(item => item.type === 'repository');
    const read = await pinned(source);
    outputs = { candidate: out('qa-candidate-v1', { ready: true, claim: `Audit Trail is implemented by ${read.text.trim()}`, sourceRef: read.ref }, [read.ref]) };
  } else if (nodeId === 'answer') {
    const memory = context.memorySnapshot.find(item => item.validity === 'current' && item.kind !== 'negative');
    const candidate = Object.values(upstream).find(value => value.candidate)?.candidate?.value;
    outputs = { answer: out('qa-answer-v1', { claim: memory?.claim ?? candidate?.claim ?? 'Unknown', claimFingerprint: digestJson(memory?.claim ?? candidate?.claim ?? 'Unknown'), evidence: memory?.dependencies ?? candidate?.sourceRef ?? 'pinned-source' }) };
  } else if (nodeId === 'clarify') {
    outputs = { clarification: out('qa-clarification-v1', { missingEvidence: 'No matching source', question: 'Which repository owns this feature?' }) };
  } else throw new Error(`Unknown Workspace Canary node: ${nodeId}`);
  return { status: 'completed', summary: `Workspace Canary ${nodeId}`, changedFiles, outputs };
};

const approve = (descriptor, current = null) => ({ actor: 'workspace-canary', decision: 'approved', action: 'workspace-register', expiresAt: '2099-09-19T00:00:00.000Z', context: workspaceDecisionContext({ input: descriptor, current }) });
const registry = new WorkspaceRegistry({ root: dataRoot, controlRoot: process.cwd() });
const requirements = await loadExtensionPack('./src/flows/requirements-design/index.mjs', { cwd: process.cwd(), controlRoot: process.cwd() });
const qa = await loadExtensionPack('./src/flows/knowledge-qa/index.mjs', { cwd: process.cwd(), controlRoot: process.cwd() });
const sourceBrief = await loadExtensionPack('./examples/onboarding/source-brief/index.mjs', { cwd: process.cwd(), controlRoot: process.cwd() });
const profile = await loadExtensionPack('./src/platform/extensions/composable-workflow.mjs', { cwd: process.cwd(), controlRoot: process.cwd() });
const extensions = [requirements, qa, sourceBrief, profile];
const runtimeManifest = { id: runtimeId, kind: 'agent-runtime', version: '1.0.0', capabilities: ['spawn', 'wait', 'send', 'heartbeat', 'interrupt', 'headless', 'workspace-shared'], permissions: [] };

const makeWorkspace = async (workspaceId, withRequirements) => {
  const outputRoot = resolve(root, `${workspaceId}-output`);
  const docs = resolve(root, `${workspaceId}-common-doc`);
  const front = resolve(root, `${workspaceId}-front`);
  const back = resolve(root, `${workspaceId}-back`);
  for (const path of [outputRoot, docs, front, back]) await mkdir(path, { recursive: true });
  await writeFile(resolve(outputRoot, 'README.md'), 'Canary output\n');
  await writeFile(resolve(docs, 'requirements.md'), 'Audit Trail requires durable events and retry.\n');
  await writeFile(resolve(front, 'client.mjs'), 'export function sendAudit(event) { return event; }\n');
  await writeFile(resolve(back, 'server.mjs'), 'export function recordAudit(event) { return event; }\n');
  const frontId = `${workspaceId}-front`;
  const backId = `${workspaceId}-back`;
  const projectIds = [frontId, backId];
  const descriptor = {
    schemaVersion: '1.0', workspaceId, alias: workspaceId,
    profiles: ['composable-workflow'], extensions: extensions.map(extension => ({ id: extension.id, version: extension.version, digest: extension.digest })),
    workflows: [qa, ...(withRequirements ? [requirements, sourceBrief] : [])].map(extension => ({ id: extension.workflows[0].id, version: extension.workflows[0].version, artifactDigest: extension.workflows[0].artifactDigest, extensionId: extension.id, profileId: 'composable-workflow', allowedProjectIds: [...projectIds], defaultProjectScope: [...projectIds], executionTargetId: 'output' })),
    projects: [{ id: frontId, sourceIds: [`${workspaceId}-common`, `${workspaceId}-frontend`], executionTargetIds: ['output'] }, { id: backId, sourceIds: [`${workspaceId}-common`, `${workspaceId}-backend`], executionTargetIds: ['output'] }],
    sources: [
      { sourceId: `${workspaceId}-common`, type: 'document', root: docs, ownerProjectId: frontId, sharedProjectIds: [backId], allowedReceivers: [runtimeId] },
      { sourceId: `${workspaceId}-frontend`, type: 'repository', root: front, ownerProjectId: frontId, allowedReceivers: [runtimeId] },
      { sourceId: `${workspaceId}-backend`, type: 'repository', root: back, ownerProjectId: backId, allowedReceivers: [runtimeId] },
    ],
    executionTargets: [{ id: 'output', root: outputRoot, projectIds: [...projectIds] }],
    resources: [
      { id: 'common', kind: 'memory', scope: 'workspace', providerRef: REFERENCE_MEMORY_PROVIDER, readProjectIds: [...projectIds], writeProjectIds: [...projectIds] },
      { id: 'front-memory', kind: 'memory', scope: 'project', projectId: frontId, providerRef: REFERENCE_MEMORY_PROVIDER, readProjectIds: [frontId], writeProjectIds: [frontId] },
      { id: 'back-memory', kind: 'memory', scope: 'project', projectId: backId, providerRef: REFERENCE_MEMORY_PROVIDER, readProjectIds: [backId], writeProjectIds: [backId] },
    ],
    policy: { agentExecutionMode: 'headless', defaultRuntimePlugin: runtimeId, runtimePlugins: [runtimeId], promptCodecPlugin: 'reference-agent-prompt-codec', maxConcurrency: 1 }, gateRecipes: [], artifactProviders: [],
  };
  const stored = await registry.register(descriptor, { commandId: `register-${workspaceId}`, authorityDecision: approve(descriptor) });
  const harness = await createHarness({ controlRoot: process.cwd(), dataRoot, workspaceId, releaseIdentity: { version: '1.0.0', artifactDigest: 'a'.repeat(64) }, strictProjectIdentity: false, extensions, executionAuthorizationAdapter: adapter });
  harness.registerPlugin(runtimeManifest, createInMemoryRuntime({ manifest: runtimeManifest, handler }));
  harnesses.set(workspaceId, harness);
  outputRoots.set(workspaceId, outputRoot);
  return { descriptor, stored, harness, projectIds, outputRoot };
};

const runLegacyWorkspace = async (workspaceId, extension, descriptor, command, decisionsBefore = [], decisionsAfter = []) => {
  const outputRoot = descriptor.workspace.root;
  const converted = workspaceFromProjectDescriptor(descriptor, { workspaceId, alias: workspaceId });
  await registry.register(converted, { commandId: `register-${workspaceId}`, authorityDecision: approve(converted) });
  const harness = await createHarness({ controlRoot: process.cwd(), dataRoot, workspaceId, releaseIdentity: { version: '1.0.0', artifactDigest: 'a'.repeat(64) }, strictProjectIdentity: false, extensions: [extension], executionAuthorizationAdapter: adapter });
  harness.registerPlugin(runtimeManifest, createInMemoryRuntime({ manifest: runtimeManifest, handler }));
  harnesses.set(workspaceId, harness);
  outputRoots.set(workspaceId, outputRoot);
  const parsed = parsePseudoCommand(command);
  assert.equal(parsed.kind, 'command');
  const plan = await harness.createWorkspaceLifecyclePlan({ workspaceAlias: parsed.projectAlias, action: parsed.action, target: parsed.target, arguments: parsed.arguments, executionAuthorizationEvidence: { explicitUnattended: true } });
  const preflight = await harness.createExecutionReadinessReport(plan);
  assert.equal(preflight.executionReady, true, JSON.stringify(preflight.checks.filter(check => !check.ready)));
  const started = await harness.startLifecyclePlan(plan, { commandId: `start-${workspaceId}`, preflightReport: preflight });
  const coordinator = new RunCoordinator({ harness });
  const approveDecision = async decisionId => {
    const state = await harness.authorityStore.read(plan.project.id, started.state.runId);
    await harness.kernel.recordDecision(plan.project.id, state.runId, { id: decisionId, actor: 'workspace-canary', decision: 'approved' }, { expectedRevision: state.revision, commandId: `${workspaceId}-${decisionId}` });
  };
  for (const id of decisionsBefore) await approveDecision(id);
  await coordinator.run({ projectId: plan.project.id, runId: started.state.runId, maxRounds: 40 });
  for (const id of decisionsAfter) {
    await approveDecision(id);
    await coordinator.run({ projectId: plan.project.id, runId: started.state.runId, maxRounds: 40 });
  }
  let state = await harness.authorityStore.read(plan.project.id, started.state.runId);
  assert(state.features.every(feature => feature.state === 'completed'), `${workspaceId} has incomplete Features`);
  state = (await harness.kernel.closeRun(plan.project.id, state.runId, {}, { expectedRevision: state.revision, commandId: `close-${workspaceId}` })).state;
  assert.equal(state.status, 'closed');
  runs.push({ command, workspaceId, workflowId: plan.workflow.id, projectIds: plan.workspaceRef.projectIds, runId: state.runId, status: state.status, planDigest: plan.planDigest, sourceManifestDigest: null });
};

const runCommand = async (command, workflowInput, { expectClosed = true } = {}) => {
  const parsed = parsePseudoCommand(command);
  assert.equal(parsed.kind, 'command', `Router rejected ${command}: ${parsed.error}`);
  const workspace = await registry.resolveAlias(parsed.projectAlias);
  const harness = harnesses.get(workspace.workspaceId);
  const plan = await harness.createWorkspaceLifecyclePlan({ workspaceId: workspace.workspaceId, workflowId: parsed.workflowId, projectIds: parsed.projectIds, action: parsed.action, target: parsed.target, arguments: parsed.arguments, workflowInput, executionAuthorizationEvidence: { explicitUnattended: true } });
  const preflight = await harness.createExecutionReadinessReport(plan);
  assert.equal(preflight.executionReady, true, JSON.stringify(preflight.checks.filter(check => !check.ready)));
  const result = await harness.executeLifecyclePlan(plan, { commandId: `workspace-canary-${runs.length}`, preflightReport: preflight, maxRounds: 40, maxConcurrency: 1, onGateProgress: () => {} });
  if (expectClosed) assert.equal(result.status, 'closed', `${command}: ${result.status}/${result.reason ?? ''}`);
  runs.push({ command, workspaceId: workspace.workspaceId, workflowId: plan.workflow.id, projectIds: plan.workspaceRef.projectIds, runId: result.state.runId, status: result.status, planDigest: plan.planDigest, sourceManifestDigest: plan.intent.workflowInput.sourceManifest.manifestDigest });
  return { plan, result };
};

try {
  const alpha = await makeWorkspace('alpha', true);
  const beta = await makeWorkspace('beta', false);
  const engineExtension = await loadExtensionPack('./integrations/legacy-consumers/cardworld/index.mjs', { cwd: process.cwd(), controlRoot: process.cwd() });
  const collectionExtension = await loadExtensionPack('./integrations/legacy-consumers/collection/index.mjs', { cwd: process.cwd(), controlRoot: process.cwd() });
  const engineRoot = resolve(root, 'engine-output');
  const collectionRoot = resolve(root, 'collection-output');
  for (const path of [engineRoot, collectionRoot]) { await mkdir(resolve(path, '.git'), { recursive: true }); await writeFile(resolve(path, 'README.md'), legacyWorkspaceReadme); }
  const engineDescriptor = createCardWorldProjectDescriptor({ id: 'engine-member', workspaceRoot: engineRoot, runtimePluginId: runtimeId, runtimePluginIds: [runtimeId], agentExecutionMode: 'headless', knownFindingInventories: { v1: { version: '1.0', sources: [{ path: 'README.md', sha256: sha256(legacyWorkspaceReadme) }], findings: [] } } });
  engineDescriptor.gateRecipes = [];
  engineDescriptor.extensions[0].digest = engineExtension.digest;
  engineDescriptor.workflows = [{ id: engineExtension.workflows[0].id, version: engineExtension.workflows[0].version, artifactDigest: engineExtension.workflows[0].artifactDigest, extensionId: engineExtension.id }];
  const collectionDescriptor = createTabletopCollectionProjectDescriptor({ id: 'collection-member', workspaceRoot: collectionRoot, runtimePluginId: runtimeId, runtimePluginIds: [runtimeId], agentExecutionMode: 'headless', batches: [{ id: 'B1', gameIds: ['game-a'], ruleStatus: 'rule-ready' }] });
  collectionDescriptor.gateRecipes = [];
  collectionDescriptor.extensions[0].digest = collectionExtension.digest;
  collectionDescriptor.workflows = [{ id: collectionExtension.workflows[0].id, version: collectionExtension.workflows[0].version, artifactDigest: collectionExtension.workflows[0].artifactDigest, extensionId: collectionExtension.id }];
  await runLegacyWorkspace('engine', engineExtension, engineDescriptor, 'h:engine full v1', [], ['canonical-requirement-approved', 'user-code-review']);
  await runLegacyWorkspace('collection', collectionExtension, collectionDescriptor, 'h:collection full B1', ['batch:B1:launched'], ['game:game-a:harness-accepted', 'game:game-a:release-review-approved', 'game:game-a:accepted', 'batch:B1:closed']);
  const requirement = await runCommand('h:alpha flow requirements-design analyze audit-trail', { outputPaths: { requirements: 'docs/requirements.md', design: 'docs/design.md' } });
  assert((await readFile(resolve(alpha.outputRoot, 'docs/requirements.md'), 'utf8')).includes('Audit Trail'));
  assert((await readFile(resolve(alpha.outputRoot, 'docs/design.md'), 'utf8')).includes('recordAudit'));
  const brief = await runCommand('h:alpha flow source-brief summarize audit-trail', { outputPaths: { brief: 'docs/brief.md' } });
  assert.equal(brief.result.status, 'closed');
  assert((await readFile(resolve(alpha.outputRoot, 'docs/brief.md'), 'utf8')).includes('recordAudit'));
  const review = requirement.result.state.submissions.find(submission => requirement.result.state.features.find(feature => feature.id === submission.featureId)?.metadata.workflow.nodeId === 'review');
  const commonSpace = requirement.plan.intent.workflowInput.memorySpaces.find(space => space.domainId.endsWith(':common'));
  const staged = await alpha.harness.memoryStore.stageFromSubmission({ space: commonSpace, projectId: requirement.plan.project.id, runId: requirement.result.state.runId, submissionId: review.submissionId, commandId: 'alpha-stage-common', expectedRevision: 0 });
  await alpha.harness.memoryStore.promote({ space: commonSpace, recordId: staged.result.recordIds[0], projectId: requirement.plan.project.id, runId: requirement.result.state.runId, submissionId: review.submissionId, verifier: { kind: 'user-confirmed', actor: 'workspace-canary' }, commandId: 'alpha-promote-common', expectedRevision: 1 });
  const frontSource = requirement.plan.intent.workflowInput.sourceManifest.sources.find(source => source.sourceId === 'alpha-frontend');
  const frontSpace = defineMemorySpace({ scope: 'project', domainId: 'workspace:alpha:resource:front-memory', projectId: requirement.plan.project.id });
  const frontRecord = await alpha.harness.memoryStore.propose({ space: frontSpace, projectId: requirement.plan.project.id, runId: requirement.result.state.runId, record: { kind: 'fact', topic: 'Front implementation', claim: 'Frontend sends audit events through sendAudit.', dependencies: [{ sourceId: frontSource.sourceId, path: frontSource.files[0].path, contentDigest: frontSource.files[0].sha256 }], evidenceRef: review.evidenceRefs[0] }, commandId: 'alpha-front-propose', expectedRevision: 0 });
  await alpha.harness.memoryStore.promote({ space: frontSpace, recordId: frontRecord.result.recordId, projectId: requirement.plan.project.id, runId: requirement.result.state.runId, submissionId: review.submissionId, verifier: { kind: 'user-confirmed', actor: 'workspace-canary' }, commandId: 'alpha-front-promote', expectedRevision: 1 });
  const frontPlan = await alpha.harness.createWorkspaceLifecyclePlan({ workspaceId: 'alpha', workflowId: 'knowledge-qa', projectIds: ['alpha-front'], action: 'ask', target: 'front-scope', workflowInput: { sessionId: 'alpha-session', questionRevision: 21, memoryTopic: 'Front implementation' } });
  const backPlan = await alpha.harness.createWorkspaceLifecyclePlan({ workspaceId: 'alpha', workflowId: 'knowledge-qa', projectIds: ['alpha-back'], action: 'ask', target: 'back-scope', workflowInput: { sessionId: 'alpha-session', questionRevision: 22, memoryTopic: 'Front implementation' } });
  assert(frontPlan.intent.workflowInput.memorySnapshot.some(record => record.recordId === frontRecord.result.recordId && record.validity === 'current'));
  assert(!backPlan.intent.workflowInput.memorySnapshot.some(record => record.recordId === frontRecord.result.recordId));
  const oldSourceIds = requirement.plan.intent.workflowInput.sourceManifest.sources.map(source => source.sourceId);
  const coverage = await alpha.harness.memoryStore.propose({ space: commonSpace, projectId: requirement.plan.project.id, runId: requirement.result.state.runId, record: { kind: 'fact', topic: 'Audit Coverage', claim: 'No other audit implementation exists in the configured repositories.', coverageSourceIds: oldSourceIds, coverageDigest: requirement.plan.intent.workflowInput.sourceManifest.sourceSetDigest, dependencies: [{ sourceId: 'alpha-common', path: 'requirements.md', contentDigest: requirement.plan.intent.workflowInput.sourceManifest.sources.find(source => source.sourceId === 'alpha-common').files[0].sha256 }], evidenceRef: review.evidenceRefs[0] }, commandId: 'alpha-coverage-propose', expectedRevision: 2 });
  await alpha.harness.memoryStore.promote({ space: commonSpace, recordId: coverage.result.recordId, projectId: requirement.plan.project.id, runId: requirement.result.state.runId, submissionId: review.submissionId, verifier: { kind: 'user-confirmed', actor: 'workspace-canary' }, commandId: 'alpha-coverage-promote', expectedRevision: 3 });
  const effectFile = alpha.harness.memoryStore.effectFile('alpha-coverage-promote');
  const committedEffect = JSON.parse(await readFile(effectFile, 'utf8'));
  await writeFile(effectFile, JSON.stringify({ ...committedEffect, status: 'pending', receipt: undefined }));
  const beforeRecoveryRevision = (await alpha.harness.memoryStore.read(commonSpace, { projectId: requirement.plan.project.id, runId: requirement.result.state.runId })).revision;
  await alpha.harness.memoryStore.recoverPendingPromotions();
  assert.equal((await alpha.harness.memoryStore.read(commonSpace, { projectId: requirement.plan.project.id, runId: requirement.result.state.runId })).revision, beforeRecoveryRevision, 'Effect recovery must not promote twice.');
  assert.equal(JSON.parse(await readFile(effectFile, 'utf8')).status, 'committed');
  const alphaQa = await runCommand('h:alpha flow knowledge-qa ask audit-trail --project alpha-front', { sessionId: 'alpha-session', questionRevision: 1, memoryTopic: 'Audit Trail' });
  assert(!alphaQa.result.state.features.some(feature => feature.metadata.workflow.nodeId === 'search'), 'Shared business knowledge should answer the front-end question.');
  const betaQa = await runCommand('h:beta ask audit-trail', { sessionId: 'beta-session', questionRevision: 1, memoryTopic: 'Audit Trail' });
  assert(betaQa.result.state.features.some(feature => feature.metadata.workflow.nodeId === 'search'), 'Another Workspace must not see Alpha knowledge.');
  await assert.rejects(beta.harness.memoryStore.query({ spaces: [commonSpace], workflowId: 'knowledge-qa', projectId: betaQa.plan.project.id, manifest: betaQa.plan.intent.workflowInput.sourceManifest, topic: 'Audit Trail' }), { code: 'WORKSPACE_MEMORY_SPACE_DENIED' });
  const backQa = await runCommand('h:alpha flow knowledge-qa ask backend-audit --project alpha-back', { sessionId: 'alpha-session', questionRevision: 2, memoryTopic: 'Audit Trail' });
  assert(!backQa.result.state.features.some(feature => feature.metadata.workflow.nodeId === 'search'), 'Shared business knowledge should answer the back-end question.');
  assert.notEqual(alphaQa.plan.project.id, betaQa.plan.project.id);
  await assert.rejects(alpha.harness.createWorkspaceLifecyclePlan({ workspaceId: 'beta', workflowId: 'knowledge-qa', action: 'ask', target: 'cross', workflowInput: { sessionId: 'x', questionRevision: 1 } }), { code: 'WORKSPACE_HARNESS_SCOPE_DENIED' });
  assert.equal(parsePseudoCommand('h:alpha ask ambiguous').kind, 'command');
  await assert.rejects(alpha.harness.createWorkspaceLifecyclePlan({ workspaceId: 'alpha', action: 'ask', target: 'ambiguous', workflowInput: { sessionId: 'x', questionRevision: 1 } }), { code: 'WORKSPACE_WORKFLOW_AMBIGUOUS' });
  const before = await alpha.harness.createWorkspaceLifecyclePlan({ workspaceId: 'alpha', workflowId: 'knowledge-qa', action: 'ask', target: 'stale', workflowInput: { sessionId: 'alpha-session', questionRevision: 3 }, executionAuthorizationEvidence: { explicitUnattended: true } });
  const analyticsId = 'alpha-analytics';
  const analyticsRoot = resolve(root, 'alpha-analytics-source');
  await mkdir(analyticsRoot, { recursive: true });
  await writeFile(resolve(analyticsRoot, 'analytics.mjs'), 'export function summarizeAudit() {}\n');
  const expanded = structuredClone(alpha.descriptor);
  expanded.projects.push({ id: analyticsId, sourceIds: ['alpha-analytics'], executionTargetIds: ['output'] });
  expanded.sources.push({ sourceId: 'alpha-analytics', type: 'repository', root: analyticsRoot, ownerProjectId: analyticsId, allowedReceivers: [runtimeId] });
  expanded.executionTargets[0].projectIds.push(analyticsId);
  for (const workflow of expanded.workflows) workflow.allowedProjectIds.push(analyticsId);
  expanded.resources.find(resource => resource.id === 'common').readProjectIds.push(analyticsId);
  expanded.resources.find(resource => resource.id === 'common').writeProjectIds.push(analyticsId);
  const expandedStored = await registry.register(expanded, { expectedRevision: 1, commandId: 'alpha-add-analytics', authorityDecision: approve(expanded, alpha.stored) });
  assert.equal(expandedStored.revision, 2);
  assert.equal((await alpha.harness.authorityStore.read(requirement.plan.project.id, requirement.result.state.runId)).metadata.sourceManifest.sources.length, 3, 'Old Run source snapshot must remain unchanged.');
  await assert.rejects(alpha.harness.startLifecyclePlan(before, { commandId: 'stale-start', preflightReport: await alpha.harness.createExecutionReadinessReport(before) }), error => error.code === 'EXECUTION_NOT_READY' && error.details.issues.some(issue => issue.code === 'LIFECYCLE_PLAN_PROJECT_STALE'));
  const after = await runCommand('h:alpha flow knowledge-qa ask expanded --projects alpha-front,alpha-back,alpha-analytics', { sessionId: 'alpha-session', questionRevision: 4, memoryTopic: 'Audit Coverage' });
  assert.equal(after.plan.intent.workflowInput.sourceManifest.sources.length, 4);
  assert.equal(after.result.status, 'closed');
  assert(after.plan.intent.workflowInput.memorySnapshot.some(record => record.recordId === coverage.result.recordId && record.validity === 'recheck-required'), 'Adding a source must invalidate full-coverage conclusions.');
  assert(after.result.state.features.some(feature => feature.metadata.workflow.nodeId === 'search'), 'Stale coverage knowledge must trigger source search.');
  const unchangedFront = await alpha.harness.createWorkspaceLifecyclePlan({ workspaceId: 'alpha', workflowId: 'knowledge-qa', projectIds: ['alpha-front'], action: 'ask', target: 'front-after-expand', workflowInput: { sessionId: 'alpha-session', questionRevision: 5, memoryTopic: 'Front implementation' } });
  assert(unchangedFront.intent.workflowInput.memorySnapshot.some(record => record.recordId === frontRecord.result.recordId && record.validity === 'current'), 'Unchanged local file knowledge remains reusable.');
  await assert.rejects(alpha.harness.createWorkspaceLifecyclePlan({ workspaceId: 'alpha', workflowId: 'requirements-design', action: 'analyze', target: 'conflict', workflowInput: { outputPaths: { requirements: 'docs/same.md', design: 'docs/same.md' } } }), { code: 'WORKFLOW_OUTPUT_CONFLICT' });
  const revocationPlan = await alpha.harness.createWorkspaceLifecyclePlan({ workspaceId: 'alpha', workflowId: 'knowledge-qa', action: 'ask', target: 'revocation-check', workflowInput: { sessionId: 'alpha-session', questionRevision: 6, memoryTopic: 'Audit Coverage' }, executionAuthorizationEvidence: { explicitUnattended: true } });
  const revocationPreflight = await alpha.harness.createExecutionReadinessReport(revocationPlan);
  assert.equal(revocationPreflight.executionReady, true);
  const revocationRun = await alpha.harness.startLifecyclePlan(revocationPlan, { commandId: 'revocation-start', preflightReport: revocationPreflight });
  const revoked = structuredClone(expanded);
  revoked.sources.find(source => source.sourceId === 'alpha-common').allowedReceivers = ['revoked-runtime'];
  const revokedStored = await registry.register(revoked, { expectedRevision: 2, commandId: 'alpha-revoke-source', authorityDecision: approve(revoked, expandedStored) });
  await assert.rejects(alpha.harness.dispatch(revocationPlan.project.id, revocationRun.state.runId, { maxConcurrency: 1 }, { expectedRevision: revocationRun.state.revision, commandId: 'revoked-dispatch' }), { code: 'WORKSPACE_SOURCE_ACCESS_REVOKED' });
  const rolled = await registry.rollback('alpha', 2, { commandId: 'alpha-rollback-source', authorityDecision: approve(expanded, revokedStored) });
  assert.equal(rolled.descriptorDigest, expandedStored.descriptorDigest);
  const resumed = new RunCoordinator({ harness: alpha.harness });
  await resumed.run({ projectId: revocationPlan.project.id, runId: revocationRun.state.runId, maxRounds: 40 });
  let resumedState = await alpha.harness.authorityStore.read(revocationPlan.project.id, revocationRun.state.runId);
  assert(resumedState.features.every(feature => feature.state === 'completed'));
  resumedState = (await alpha.harness.kernel.closeRun(revocationPlan.project.id, resumedState.runId, {}, { expectedRevision: resumedState.revision, commandId: 'revocation-recovered-close' })).state;
  assert.equal(resumedState.status, 'closed');
  runs.push({ command: 'h:alpha flow knowledge-qa ask revocation-check', workspaceId: 'alpha', workflowId: 'knowledge-qa', projectIds: revocationPlan.workspaceRef.projectIds, runId: resumedState.runId, status: resumedState.status, planDigest: revocationPlan.planDigest, sourceManifestDigest: revocationPlan.intent.workflowInput.sourceManifest.manifestDigest, recoveredAfterRollback: true });
  const wrongProvider = structuredClone(expanded);
  wrongProvider.resources.find(resource => resource.id === 'common').providerRef.artifactDigest = 'f'.repeat(64);
  const wrongStored = await registry.register(wrongProvider, { expectedRevision: 4, commandId: 'alpha-wrong-provider', authorityDecision: approve(wrongProvider, rolled) });
  await assert.rejects(alpha.harness.createWorkspaceLifecyclePlan({ workspaceId: 'alpha', workflowId: 'knowledge-qa', action: 'ask', target: 'provider-check', workflowInput: { sessionId: 'alpha-session', questionRevision: 7 } }), { code: 'RESOURCE_PROVIDER_IDENTITY_MISMATCH' });
  const restored = await registry.rollback('alpha', 2, { commandId: 'alpha-restore-provider', authorityDecision: approve(expanded, wrongStored) });
  const driftPlan = await alpha.harness.createWorkspaceLifecyclePlan({ workspaceId: 'alpha', workflowId: 'knowledge-qa', action: 'ask', target: 'drift-check', workflowInput: { sessionId: 'alpha-session', questionRevision: 8 }, executionAuthorizationEvidence: { explicitUnattended: true } });
  const driftSource = expanded.sources.find(source => source.sourceId === 'alpha-backend');
  const driftFile = resolve(driftSource.root, 'server.mjs');
  const originalBytes = await readFile(driftFile);
  await writeFile(driftFile, 'export function recordAudit(event) { throw Error("changed"); }\n');
  await assert.rejects(alpha.harness.startLifecyclePlan(driftPlan, { commandId: 'drift-start', preflightReport: await alpha.harness.createExecutionReadinessReport(driftPlan) }), { code: 'SOURCE_DRIFT' });
  await writeFile(driftFile, originalBytes);
  console.log(JSON.stringify({ ok: true, command: 'npm run workspace:canary', runs, workspaceRevisions: { alpha: restored.revision, beta: beta.stored.revision }, sharedMemoryId: staged.result.recordIds[0], projectMemoryId: frontRecord.result.recordId, coverageMemoryId: coverage.result.recordId, coverageInvalidated: true, effectRecoveredWithoutDuplicate: true, revokedDispatchBlocked: true, providerMismatchBlocked: true, sourceDriftBlocked: true, oldRunSourceCount: 3, expandedSourceCount: 4 }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
