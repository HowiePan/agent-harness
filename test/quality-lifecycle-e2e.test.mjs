import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHarness } from '../src/application/harness.mjs';
import { createCardWorldProjectDescriptor } from '../integrations/legacy-consumers/cardworld/index.mjs';
import { loadExtensionPack } from '../src/platform/extensions/contract.mjs';
import { createVisibleHostAdapter } from '../src/platform/plugins/runtime/visible-host-adapter.mjs';
import { harnessTemporaryRoot } from '../src/common/write-boundary.mjs';
import { digestJson, sha256 } from '../src/common/canonical.mjs';

const releaseIdentity = { version: '1.0.0', artifactDigest: 'a'.repeat(64), verified: true };

const result = ({ summary, findings = [], changedFiles = [], checkpoint = 'review', knownFindingDispositions = undefined, diagnosticDispositions = undefined, diagnostics = undefined, outputs = undefined }) => ({
  status: 'completed',
  summary,
  checkpoints: [{ id: checkpoint, status: 'passed', summary, evidence: [`host:${checkpoint}`] }],
  made: [],
  notMade: [],
  changedFiles,
  observations: [],
  findings,
  ...(outputs ? { outputs } : {}),
  ...(knownFindingDispositions ? { knownFindingDispositions } : {}),
  ...(diagnosticDispositions ? { diagnosticDispositions } : {}),
  ...(diagnostics ? { diagnostics } : {}),
  followUpFeatures: [],
  failureClass: null,
  blocker: null,
});

const finding = {
  id: 'Q-E2E-001',
  severity: 'P1',
  summary: 'Fixture requires a verified repair.',
  evidence: ['README.md:1'],
  affectedPaths: ['README.md'],
  symbols: [],
  contracts: [],
  generatedOutputs: [],
  conflictKeys: ['fixture-readme'],
};
const openDisposition = [{ id: finding.id, disposition: 'open', evidence: ['README.md:1'] }];
const cleanDisposition = [{ id: finding.id, disposition: 'not-reproduced', evidence: ['fresh README.md check'] }];
const externalFinding = { ...finding, id: 'Q-E2E-002', summary: 'Separate fixture file fails a full check.', evidence: ['OTHER.md:1'], affectedPaths: ['OTHER.md'], conflictKeys: ['fixture-other'] };
const overlappingFinding = { ...finding, id: 'Q-E2E-003', summary: 'Second defect in the same file.', evidence: ['README.md:2'] };
const externalDiagnostic = { id: 'full-check-other', summary: 'Full check fails in OTHER.md.', evidence: ['host:full-check:OTHER.md:1'] };

const createHost = ({ workspace, failFirstWait = false, failFirstInspect = false, failFirstConfirm = false, failFirstResult = false, repeatFindingOnce = false, rejectRepairResultWithEdit = false, invalidRepairCheckpointOnce = false, externalDiagnosticOnce = false, overlappingFindings = false, missingDiagnosticDispositionOnce = false }) => {
  const agents = new Map();
  const stats = { spawnCount: 0, containCount: 0, terminalCount: 0, maxActive: 0, reconcileCount: 0 };
  let sequence = 0;
  let shouldFailWait = failFirstWait;
  let shouldFailInspect = failFirstInspect;
  let shouldFailConfirm = failFirstConfirm;
  let shouldFailResult = failFirstResult;
  let shouldRepeatFinding = repeatFindingOnce;
  let shouldRejectRepairCheckpoint = invalidRepairCheckpointOnce;
  let shouldReportExternalDiagnostic = externalDiagnosticOnce;
  let shouldConfirmExternalFinding = externalDiagnosticOnce;
  let shouldOmitDiagnosticDisposition = missingDiagnosticDispositionOnce;
  const adapter = createVisibleHostAdapter({
    provider: 'quality-e2e-host',
    adapterVersion: '1.1.0',
    reconcileVisibleHostEffects: async () => {
      stats.reconcileCount += 1;
      return {
        ready: true,
        provider: 'quality-e2e-host',
        adapterVersion: '1.1.0',
        contract: { id: 'quality-e2e-native', version: '1.0.0', digest: 'd'.repeat(64) },
        assertionId: 'quality-e2e-reconciliation',
        observedAt: new Date().toISOString(),
        reconciled: [],
        issues: [],
      };
    },
    inspectVisibleAgent: async expected => {
      if (shouldFailInspect) {
        shouldFailInspect = false;
        const error = new Error('simulated attestation failure after spawn');
        error.code = 'SIMULATED_ATTESTATION_FAILURE';
        throw error;
      }
      return {
        verified: true,
        status: 'running',
        assertionId: `assertion:${expected.agentId}`,
        observedAt: new Date().toISOString(),
        agentId: expected.agentId,
        dispatchId: expected.dispatchId,
        packetDigest: expected.packetDigest,
        promptDigest: expected.promptDigest,
        visibility: { mode: 'user-visible', surface: expected.surface, inspectRef: expected.inspectRef },
      };
    },
    spawnVisibleAgent: async input => {
      stats.spawnCount += 1;
      const agentId = `visible-e2e-${++sequence}`;
      const visibility = { mode: 'user-visible', surface: 'codex-task', inspectRef: `task:${agentId}` };
      agents.set(agentId, { ...structuredClone(input), visibility, repaired: false });
      stats.maxActive = Math.max(stats.maxActive, agents.size);
      return { agentId, visibility, receipt: { operation: 'spawn', agentId } };
    },
    confirmVisibleLease: async input => {
      if (shouldFailConfirm) {
        shouldFailConfirm = false;
        const error = new Error('simulated coordinator crash after Authority Lease commit');
        error.code = 'SIMULATED_CONFIRMATION_FAILURE';
        throw error;
      }
      return { confirmed: true, agentId: input.agentId };
    },
    containVisibleAgent: async input => {
      stats.containCount += 1;
      return { contained: agents.delete(input.agentId), agentId: input.agentId };
    },
    waitVisibleAgent: async input => {
      if (shouldFailWait) {
        shouldFailWait = false;
        const error = new Error('simulated host restart after Lease binding');
        error.code = 'SIMULATED_HOST_RESTART';
        throw error;
      }
      assert(agents.has(input.agentId));
      return { status: 'completed', progress: 'completed', receipt: { operation: 'wait', agentId: input.agentId } };
    },
    readVisibleResult: async input => {
      const task = agents.get(input.agentId);
      assert(task);
      const finish = output => {
        agents.delete(input.agentId);
        stats.terminalCount += 1;
        return output;
      };
      const stage = task.packet.feature.metadata.stage;
      if (stage === 'quality') {
        if (shouldFailResult) {
          shouldFailResult = false;
          return finish({
            result: {
              ...result({ summary: 'Visible Agent failed before completing the review.', checkpoint: 'runtime-failure' }),
              status: 'failed',
              failureClass: 'runtime-provider',
              blocker: { kind: 'runtime-provider', summary: 'Visible Agent failed before completing the review.', resumeWhen: null, code: 'SIMULATED_VISIBLE_AGENT_FAILED' },
            },
            receipt: { operation: 'result', stage },
          });
        }
        const found = overlappingFindings ? [finding, overlappingFinding] : [finding];
        return finish({ result: result({ summary: 'Initial full review found defects.', findings: found, knownFindingDispositions: openDisposition, outputs: { quality: { schemaId: 'delivery-quality-v1', value: { findings: found }, evidenceRefs: ['host:review'] } } }), receipt: { operation: 'result', stage } });
      }
      if (stage === 'quality-repair') {
        const repairPath = task.packet.feature.metadata.repairFindingId === externalFinding.id ? 'OTHER.md' : 'README.md';
        if (!task.repaired) {
          const current = await readFile(resolve(workspace, repairPath), 'utf8');
          if (!current.includes('verified repair')) await writeFile(resolve(workspace, repairPath), `${current.trimEnd()}\nverified repair\n`, 'utf8');
          task.changed = !current.includes('verified repair');
          task.repaired = true;
        }
        if (shouldReportExternalDiagnostic) {
          shouldReportExternalDiagnostic = false;
          return finish({ result: result({ summary: 'Focused repair passed; separate full check failed.', changedFiles: ['README.md'], checkpoint: 'focused-check', diagnostics: [externalDiagnostic] }), runtimeEvidence: { verificationReceipts: [{ id: 'focused-check', status: 'passed', evidence: ['README.md'] }] }, receipt: { operation: 'result', stage } });
        }
        if (shouldRejectRepairCheckpoint) {
          shouldRejectRepairCheckpoint = false;
          return finish({
            result: { ...result({ summary: 'Focused repair passed; unrelated full check blocked.', changedFiles: ['README.md'], checkpoint: 'focused-check' }), checkpoints: [
              { id: 'focused-check', status: 'passed', summary: 'Focused check passed.', evidence: ['host:focused-check'] },
              { id: 'full-targets', status: 'blocked', summary: 'Unrelated test file is outside the repair scope.', evidence: ['host:full-targets'] },
            ] },
            runtimeEvidence: { verificationReceipts: [{ id: 'focused-check', status: 'passed', evidence: ['README.md'] }] },
            receipt: { operation: 'result', stage, observationRequestDigest: 'b'.repeat(64) },
          });
        }
        if (rejectRepairResultWithEdit) {
          const rejectionBody = {
            kind: 'result-rejected-receipt', version: '1.0', agentId: input.agentId, dispatchId: input.dispatchId,
            packetDigest: task.packetDigest, promptDigest: input.runtimeReceipt.prompt.promptDigest,
            resultContractDigest: input.runtimeReceipt.resultContractDigest,
            code: 'CODEX_COLLABORATION_RESULT_JSON_INVALID', nativeOutputDigest: sha256('invalid native output'),
            errors: [], observationRequestDigest: 'a'.repeat(64),
          };
          const receiptDigest = digestJson(rejectionBody);
          return finish({
            result: { status: 'failed', summary: 'Invalid native result after repair edit.', changedFiles: [], failureClass: 'runtime-contract', blocker: { kind: 'runtime-contract', summary: 'Invalid native result.', code: rejectionBody.code } },
            runtimeEvidence: { resultRejection: { ...rejectionBody, receiptDigest }, verificationReceipts: [] },
            receipt: { operation: 'result', stage, rejectionDigest: receiptDigest },
          });
        }
        const groupedIds = task.packet.feature.metadata.repairFindingIds ?? [];
        return finish({
          result: { ...result({ summary: 'Finding repaired and verified.', changedFiles: task.changed ? [repairPath] : [], checkpoint: 'repair-verification' }), ...(groupedIds.length > 1 ? { checkpoints: groupedIds.map(id => ({ id: `verify:${id}`, status: 'passed', summary: `Verified ${id}`, evidence: [`host:verify:${id}`] })) } : {}) },
          runtimeEvidence: { verificationReceipts: [{ id: 'focused-check', status: 'passed', evidence: [repairPath] }] },
          receipt: { operation: 'result', stage },
        });
      }
      assert.equal(stage, 'quality-recheck');
      const gateDiagnostic = task.packet.feature.metadata.diagnostics?.find(item => item.id.startsWith('gate:'));
      if (gateDiagnostic) {
        return finish({ result: result({ summary: 'Gate failure confirms a separate source defect.', findings: [externalFinding], diagnosticDispositions: [{ id: gateDiagnostic.id, disposition: 'finding', findingId: externalFinding.id, evidence: ['fresh OTHER.md Gate reproduction'] }], knownFindingDispositions: cleanDisposition, checkpoint: 'gate-diagnostic' }), receipt: { operation: 'result', stage } });
      }
      if (shouldConfirmExternalFinding) {
        if (shouldOmitDiagnosticDisposition) {
          shouldOmitDiagnosticDisposition = false;
          return finish({ result: result({ summary: 'Review omitted a required diagnostic disposition.', knownFindingDispositions: cleanDisposition, checkpoint: 'recheck' }), receipt: { operation: 'result', stage, observationRequestDigest: 'c'.repeat(64) } });
        }
        shouldConfirmExternalFinding = false;
        return finish({ result: result({ summary: 'Independent review confirmed the separate diagnostic.', findings: [externalFinding], diagnosticDispositions: [{ id: externalDiagnostic.id, disposition: 'finding', findingId: externalFinding.id, evidence: ['fresh OTHER.md check'] }], knownFindingDispositions: cleanDisposition, checkpoint: 'recheck' }), receipt: { operation: 'result', stage } });
      }
      if (shouldRepeatFinding) {
        shouldRepeatFinding = false;
        return finish({ result: result({ summary: 'First re-review found the same defect again.', findings: [finding], knownFindingDispositions: openDisposition, checkpoint: 'recheck' }), receipt: { operation: 'result', stage } });
      }
      return finish({ result: result({ summary: 'Post-repair full re-review is clean.', knownFindingDispositions: cleanDisposition, diagnosticDispositions: task.packet.feature.metadata.diagnostics?.length ? [{ id: externalDiagnostic.id, disposition: 'not-reproduced', evidence: ['fresh OTHER.md check after repair'] }] : undefined, checkpoint: 'recheck' }), receipt: { operation: 'result', stage } });
    },
  });
  return { adapter, agents, stats };
};

const setup = async ({ failFirstWait = false, failFirstInspect = false, failFirstConfirm = false, failFirstResult = false, repeatFindingOnce = false, rejectRepairResultWithEdit = false, invalidRepairCheckpointOnce = false, externalDiagnosticOnce = false, gateFailureUntilRepair = false, overlappingFindings = false, missingDiagnosticDispositionOnce = false, preset = 'full' } = {}) => {
  const controlRoot = resolve(process.cwd());
  const parent = resolve(harnessTemporaryRoot(), 'quality-lifecycle-e2e');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'case-'));
  const workspace = resolve(root, 'CardWorld');
  const dataRoot = resolve(root, 'data');
  await mkdir(resolve(workspace, '.git'), { recursive: true });
  await writeFile(resolve(workspace, 'README.md'), '# Quality fixture\n', 'utf8');
  await writeFile(resolve(workspace, 'OTHER.md'), '# Separate fixture\n', 'utf8');
  const engine = await loadExtensionPack('./integrations/legacy-consumers/cardworld/index.mjs', { cwd: controlRoot, controlRoot });
  const runtime = await loadExtensionPack('./integrations/codex/extensions/codex-runtime.mjs', { cwd: controlRoot, controlRoot });
  const host = createHost({ workspace, failFirstWait, failFirstInspect, failFirstConfirm, failFirstResult, repeatFindingOnce, rejectRepairResultWithEdit, invalidRepairCheckpointOnce, externalDiagnosticOnce, overlappingFindings, missingDiagnosticDispositionOnce });
  const create = () => createHarness({ controlRoot, dataRoot, releaseIdentity, strictProjectIdentity: false, extensions: [engine, runtime], agentAdapter: host.adapter });
  const harness = await create();
  const descriptor = createCardWorldProjectDescriptor({ workspaceRoot: workspace, harness: releaseIdentity, knownFindingInventories: { 'V3.8.4': { version: '1.0', sources: [{ path: 'README.md', sha256: sha256('# Quality fixture\n') }], findings: [{ id: finding.id, severity: finding.severity, sourcePath: 'README.md' }] } } });
  descriptor.gateRecipes = gateFailureUntilRepair ? [{ id: 'fixture-gate', scope: 'final', required: true, executionClass: 'deterministic-process', command: [process.execPath, '-e', "process.exit(require('node:fs').readFileSync('OTHER.md','utf8').includes('verified repair') ? 0 : 1)"] }] : [];
  descriptor.extensions = descriptor.extensions.map(item => ({ ...item, digest: item.id === engine.id ? engine.digest : runtime.digest }));
  await harness.projectRegistry.register(descriptor, { expectedRevision: 0, commandId: 'quality-e2e-project' });
  const plan = await harness.createLifecyclePlan({ projectId: descriptor.id, action: 'quality', target: 'V3.8.4', arguments: [preset], extensionId: engine.id, executionWorkspaceRoot: workspace });
  return { root, workspace, dataRoot, host, create, harness, plan };
};

const assertClosedQualityLoop = state => {
  assert.equal(state.status, 'closed');
  assert.deepEqual(state.features.map(feature => feature.metadata.stage), ['quality', 'quality-repair', 'quality-recheck']);
  assert.equal(state.features.every(feature => feature.state === 'completed'), true);
  assert.equal(state.findings.length, 1);
  assert.equal(state.findings[0].status, 'resolved');
  assert.equal(state.findings[0].resolutionEvidenceRefs.length > 0, true);
  const recheck = state.features.find(feature => feature.metadata.stage === 'quality-recheck');
  const recheckSubmission = state.submissions.find(submission => submission.featureId === recheck.id);
  assert.equal(recheck.metadata.reviewSourceDigest, recheckSubmission.inputSourceDigest);
  assert.equal(recheckSubmission.outputSourceDigest, state.sourceDigest);
  assert.equal(state.receipts.some(receipt => receipt.kind === 'run-closure'), true);
};

test('visible quality lifecycle completes review, verified repair, fresh re-review, and closure', async t => {
  const fixture = await setup();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  assert.equal(fixture.plan.run.features[0].metadata.sourcePolicy, 'read-only');
  assert.equal(fixture.plan.run.features[0].metadata.qualityFindingPolicy, 'repair-and-rereview');
  const preflight = await fixture.harness.createExecutionReadinessReport(fixture.plan);
  assert.equal(preflight.executionReady, true);
  const completed = await fixture.harness.executeVisibleLifecyclePlan(fixture.plan, { commandId: 'quality-e2e', preflightReport: preflight, maxConcurrency: 10 });
  for (const dispatch of completed.state.dispatches) assert.equal(sha256(await readFile(`${dispatch.outputRef}.dispatch-packet.json`, 'utf8')), dispatch.packetDigest);
  assert.equal(completed.rounds.every(round => round.physicalLimit === 1), true);
  assert.equal(completed.rounds.every(round => round.elapsedMs >= 0 && ['spawnMs', 'waitMs', 'resultMs'].every(key => round.timing[key] >= 0)), true);
  assertClosedQualityLoop(completed.state);
});

test('out-of-scope check diagnostic is confirmed by review and repaired in the same Run', async t => {
  const fixture = await setup({ externalDiagnosticOnce: true });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const preflight = await fixture.harness.createExecutionReadinessReport(fixture.plan);
  const completed = await fixture.harness.executeVisibleLifecyclePlan(fixture.plan, { commandId: 'quality-external-diagnostic', preflightReport: preflight });
  assert.equal(completed.status, 'closed');
  assert.equal(fixture.host.stats.spawnCount, 5);
  assert.equal(completed.state.findings.find(item => item.id === externalFinding.id)?.status, 'resolved');
  assert.equal(completed.state.features.find(item => item.metadata?.repairFindingId === externalFinding.id)?.allowedPaths.includes('OTHER.md'), true);
  assert.match(await readFile(resolve(fixture.workspace, 'OTHER.md'), 'utf8'), /verified repair/);
});

test('missing diagnostic disposition is rejected and reviewed again without stopping the Run', async t => {
  const fixture = await setup({ externalDiagnosticOnce: true, missingDiagnosticDispositionOnce: true });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const preflight = await fixture.harness.createExecutionReadinessReport(fixture.plan);
  const completed = await fixture.harness.executeVisibleLifecyclePlan(fixture.plan, { commandId: 'quality-diagnostic-retry', preflightReport: preflight });
  assert.equal(completed.status, 'closed');
  assert.equal(fixture.host.stats.spawnCount, 6);
  assert.equal(completed.state.submissions.some(item => item.result.failureClass === 'runtime-contract' && item.result.blocker.code === 'QUALITY_DIAGNOSTIC_DISPOSITION_REQUIRED'), true);
  assert.equal(completed.state.findings.find(item => item.id === externalFinding.id)?.status, 'resolved');
});

test('overlapping findings share one repair dispatch with evidence per Finding', async t => {
  const fixture = await setup({ overlappingFindings: true });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const preflight = await fixture.harness.createExecutionReadinessReport(fixture.plan);
  const completed = await fixture.harness.executeVisibleLifecyclePlan(fixture.plan, { commandId: 'quality-grouped-repair', preflightReport: preflight });
  assert.equal(completed.status, 'closed');
  assert.equal(fixture.host.stats.spawnCount, 3);
  assert.deepEqual(completed.state.features.filter(feature => feature.metadata.stage === 'quality-repair').map(feature => feature.metadata.repairFindingIds), [[finding.id, overlappingFinding.id]]);
  assert.equal(completed.state.findings.every(item => item.status === 'resolved'), true);
});

test('failed final Gate creates bounded diagnostic review and repair in the same Run', async t => {
  const fixture = await setup({ gateFailureUntilRepair: true });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const onGateProgress = () => {};
  const preflight = await fixture.harness.createExecutionReadinessReport(fixture.plan, { onGateProgress });
  const completed = await fixture.harness.executeVisibleLifecyclePlan(fixture.plan, { commandId: 'quality-gate-diagnostic', preflightReport: preflight, onGateProgress });
  assert.equal(completed.status, 'closed');
  assert.equal(fixture.host.stats.spawnCount, 6);
  assert.equal(completed.state.features.some(feature => feature.id.startsWith('quality-gate-diagnostic-')), true);
  assert.equal(completed.state.findings.find(item => item.id === externalFinding.id)?.status, 'resolved');
  assert.equal(completed.state.gates.find(gate => gate.id === 'fixture-gate')?.status, 'passed');
});

test('visible lifecycle refreshes expired readiness for the same Plan before opening its Run', async t => {
  const fixture = await setup();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const expired = await fixture.harness.createExecutionReadinessReport(fixture.plan, { ttlMs: -1 });
  const completed = await fixture.harness.executeVisibleLifecyclePlan(fixture.plan, { commandId: 'quality-expired-readiness', preflightReport: expired });
  assertClosedQualityLoop(completed.state);
  assert.equal(fixture.host.stats.spawnCount, 3);
});

test('review-only quality records findings without scheduling repairs or changing source', async t => {
  const fixture = await setup({ preset: 'review-only' });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  assert.equal(fixture.plan.run.features[0].metadata.qualityFindingPolicy, 'record-only');
  const before = await readFile(resolve(fixture.workspace, 'README.md'), 'utf8');
  const preflight = await fixture.harness.createExecutionReadinessReport(fixture.plan);
  assert.equal(preflight.executionReady, true);
  const stopped = await fixture.harness.executeVisibleLifecyclePlan(fixture.plan, { commandId: 'quality-review-only-e2e', preflightReport: preflight });
  assert.equal(stopped.status, 'attention-required');
  assert.equal(stopped.reason, 'current-source-clean-quality-review-required');
  assert.deepEqual(stopped.state.features.map(feature => feature.metadata.stage), ['quality']);
  assert.equal(stopped.state.findings.length, 1);
  assert.equal(stopped.state.findings[0].status, 'open');
  assert.equal(fixture.host.stats.spawnCount, 1);
  assert.equal(await readFile(resolve(fixture.workspace, 'README.md'), 'utf8'), before);
});

test('visible quality lifecycle resumes an attested active Lease after coordinator restart', async t => {
  const fixture = await setup({ failFirstWait: true });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const firstPreflight = await fixture.harness.createExecutionReadinessReport(fixture.plan);
  await assert.rejects(
    () => fixture.harness.executeVisibleLifecyclePlan(fixture.plan, { commandId: 'quality-before-restart', preflightReport: firstPreflight, maxConcurrency: 1 }),
    error => error.code === 'SIMULATED_HOST_RESTART',
  );
  const interrupted = await fixture.harness.authorityStore.read(fixture.plan.project.id, fixture.plan.run.runId);
  assert.equal(interrupted.leases.filter(lease => lease.status === 'active').length, 1);

  const restartedHarness = await fixture.create();
  const resumedPreflight = await restartedHarness.createExecutionReadinessReport(fixture.plan);
  assert.equal(resumedPreflight.executionReady, true);
  assert.equal(resumedPreflight.checks.find(check => check.id === 'active-leases').details.observations.length, 1);
  const completed = await restartedHarness.executeVisibleLifecyclePlan(fixture.plan, { commandId: 'quality-after-restart', preflightReport: resumedPreflight, maxConcurrency: 1 });
  assertClosedQualityLoop(completed.state);
});

test('blocked lineage does not reconcile or contain a live visible Agent', async t => {
  const fixture = await setup({ failFirstWait: true });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const firstPreflight = await fixture.harness.createExecutionReadinessReport(fixture.plan);
  await assert.rejects(() => fixture.harness.executeVisibleLifecyclePlan(fixture.plan, { commandId: 'blocked-lineage-first', preflightReport: firstPreflight, maxConcurrency: 1 }), error => error.code === 'SIMULATED_HOST_RESTART');
  const before = fixture.host.stats.reconcileCount;
  await writeFile(resolve(fixture.workspace, 'OTHER.md'), '# Different source\n', 'utf8');
  const nextPlan = await fixture.harness.createLifecyclePlan({ projectId: fixture.plan.project.id, action: 'quality', target: 'V3.8.4', arguments: ['full'], extensionId: fixture.plan.extension.id, executionWorkspaceRoot: fixture.workspace });
  const blocked = await fixture.harness.createExecutionReadinessReport(nextPlan);
  assert.equal(blocked.checks.find(check => check.id === 'run-lineage').details.resolution.reasonCode, 'INCOMPATIBLE_LIVE_LEASE');
  assert.equal(blocked.checks.find(check => check.id === 'visible-host-contract').issues[0].code, 'RUN_LINEAGE_BLOCKED');
  assert.equal(blocked.checks.find(check => check.id === 'write-capability').issues[0].code, 'RUN_LINEAGE_BLOCKED');
  assert.equal(blocked.writeProbe.attempted, false);
  assert.equal(fixture.host.stats.reconcileCount, before);
  assert.equal(fixture.host.agents.size, 1);
});

test('spawn-before-bind failure contains the prior Agent and never opens the next Agent', async t => {
  const fixture = await setup({ failFirstInspect: true });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const preflight = await fixture.harness.createExecutionReadinessReport(fixture.plan);
  await assert.rejects(
    () => fixture.harness.executeVisibleLifecyclePlan(fixture.plan, { commandId: 'quality-bind-failure', preflightReport: preflight, maxConcurrency: 10 }),
    error => error.code === 'SIMULATED_ATTESTATION_FAILURE',
  );
  assert.equal(fixture.host.stats.spawnCount, 1);
  assert.equal(fixture.host.stats.containCount, 1);
  assert.equal(fixture.host.agents.size, 0);
  const state = await fixture.harness.authorityStore.read(fixture.plan.project.id, fixture.plan.run.runId);
  assert.equal(state.leases.filter(lease => lease.status === 'active').length, 0);
  assert.equal(state.dispatches.filter(dispatch => dispatch.status === 'requested').length, 1);
});

test('terminal Agent failure is committed and blocks the lifecycle before any next Agent starts', async t => {
  const fixture = await setup({ failFirstResult: true });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const preflight = await fixture.harness.createExecutionReadinessReport(fixture.plan);
  const stopped = await fixture.harness.executeVisibleLifecyclePlan(fixture.plan, { commandId: 'quality-terminal-stop', preflightReport: preflight, maxConcurrency: 10 });
  assert.equal(stopped.status, 'attention-required');
  assert.equal(stopped.reason, 'all-remaining-blocked');
  assert.equal(fixture.host.stats.spawnCount, 1);
  assert.equal(fixture.host.stats.terminalCount, 1);
  assert.equal(fixture.host.stats.maxActive, 1);
  assert.equal(stopped.rounds.filter(round => Object.hasOwn(round, 'physicalLimit')).every(round => round.physicalLimit === 1), true);
  assert.equal(stopped.state.submissions.length, 1);
  assert.equal(stopped.state.submissions[0].result.status, 'failed');
  assert.equal(stopped.state.leases.filter(lease => lease.status === 'active').length, 0);
});

test('rejected native repair result records observed edits and closes its Lease', async t => {
  const fixture = await setup({ rejectRepairResultWithEdit: true });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const preflight = await fixture.harness.createExecutionReadinessReport(fixture.plan);
  const stopped = await fixture.harness.executeVisibleLifecyclePlan(fixture.plan, { commandId: 'quality-rejected-repair', preflightReport: preflight, maxConcurrency: 1 });
  assert.equal(stopped.status, 'attention-required');
  assert.equal(stopped.state.submissions.at(-1).result.status, 'failed');
  assert.deepEqual(stopped.state.submissions.at(-1).result.changedFiles, ['README.md']);
  assert.equal(stopped.state.leases.filter(lease => lease.status === 'active').length, 0);
  assert.equal(fixture.host.stats.spawnCount, 2);
});

test('invalid completed repair checkpoint is preserved and retried in the same visible lifecycle', async t => {
  const fixture = await setup({ invalidRepairCheckpointOnce: true });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const preflight = await fixture.harness.createExecutionReadinessReport(fixture.plan);
  const completed = await fixture.harness.executeVisibleLifecyclePlan(fixture.plan, { commandId: 'quality-checkpoint-retry', preflightReport: preflight, maxConcurrency: 1 });
  assert.equal(completed.status, 'closed');
  assert.equal(fixture.host.stats.spawnCount, 4);
  const rejected = completed.state.submissions.find(item => item.result.blocker?.code === 'REPAIR_CHECKPOINT_EVIDENCE_REQUIRED');
  assert(rejected);
  assert.deepEqual(rejected.changedFiles, ['README.md']);
  assert.equal(rejected.result.status, 'failed');
  assert.equal(completed.state.features.find(item => item.metadata.stage === 'quality-repair').state, 'completed');
  assert.equal(completed.state.findings[0].status, 'resolved');
});

test('post-bind confirmation failure preserves the active Lease for reattachment without interrupting its Agent', async t => {
  const fixture = await setup({ failFirstConfirm: true });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const preflight = await fixture.harness.createExecutionReadinessReport(fixture.plan);
  await assert.rejects(
    () => fixture.harness.executeVisibleLifecyclePlan(fixture.plan, { commandId: 'quality-confirm-failure', preflightReport: preflight, maxConcurrency: 1 }),
    error => error.code === 'SIMULATED_CONFIRMATION_FAILURE' && error.details?.leaseBound === true,
  );
  assert.equal(fixture.host.stats.spawnCount, 1);
  assert.equal(fixture.host.stats.containCount, 0);
  const interrupted = await fixture.harness.authorityStore.read(fixture.plan.project.id, fixture.plan.run.runId);
  assert.equal(interrupted.leases.filter(lease => lease.status === 'active').length, 1);
  const restarted = await fixture.create();
  const resumedPreflight = await restarted.createExecutionReadinessReport(fixture.plan);
  assert.equal(resumedPreflight.executionReady, true);
});

test('a finding repeated by re-review is reopened, repaired in a new round, and reviewed again', async t => {
  const fixture = await setup({ repeatFindingOnce: true });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const preflight = await fixture.harness.createExecutionReadinessReport(fixture.plan);
  const completed = await fixture.harness.executeVisibleLifecyclePlan(fixture.plan, { commandId: 'quality-repeat-finding', preflightReport: preflight, maxConcurrency: 1 });
  assert.equal(completed.state.status, 'closed');
  assert.deepEqual(completed.state.features.map(feature => feature.metadata.stage), ['quality', 'quality-repair', 'quality-recheck', 'quality-repair', 'quality-recheck']);
  assert.equal(completed.state.findings[0].status, 'resolved');
  assert.equal(completed.state.findings[0].history.length, 1);
});
