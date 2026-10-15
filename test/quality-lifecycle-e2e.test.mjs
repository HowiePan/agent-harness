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
import { createQualityFollowUpFeatures, createQualityGateDiagnosticReview, repairsForFindings, validateQualityReviewPolicies } from '../src/flow-kit/profiles/quality-loop.mjs';
import { qualityReviewBudgetExhausted } from '../src/flow-kit/profiles/quality-budget.mjs';
import { retireUnresumableQualityRun } from '../src/application/quality-run-retirement.mjs';
import { createDeliveryLifecycleProfile } from '../src/flows/delivery-lifecycle/policy/delivery-lifecycle.mjs';

const releaseIdentity = { version: '1.0.0', artifactDigest: 'a'.repeat(64), verified: true };

test('quality verification outputs must stay within the workspace and outside forbidden paths', () => {
  const feature = {
    id: 'quality', allowedPaths: [], forbiddenPaths: ['.git'],
    metadata: { qualityReview: true, qualityFindingPolicy: 'repair-and-rereview', sourcePolicy: 'read-only', qualityContext: { verificationOutputPaths: ['build'] } },
  };
  assert.doesNotThrow(() => validateQualityReviewPolicies([feature]));
  for (const path of ['../outside', 'C:/outside', '/outside', '.git/objects']) {
    const invalid = structuredClone(feature);
    invalid.metadata.qualityContext.verificationOutputPaths = [path];
    assert.throws(() => validateQualityReviewPolicies([invalid]), error => error.code === (path === '.git/objects' ? 'QUALITY_VERIFICATION_OUTPUT_FORBIDDEN' : 'QUALITY_VERIFICATION_OUTPUT_PATH_INVALID'));
  }
});

test('environment Gate failures do not become source-repair Findings', () => {
  const state = {
    sourceDigest: 'a'.repeat(64),
    features: [{ id: 'quality', state: 'completed', metadata: { qualityReview: true, qualityFindingPolicy: 'repair-and-rereview', qualityRoot: 'quality:fixture', reviewRound: 1 } }],
  };
  assert.equal(createQualityGateDiagnosticReview({ state, gateResults: [{ id: 'wasm', status: 'environment-failed', evidenceRefs: ['access-denied'] }] }), null);
});

test('a quality Finding cannot turn verification output into a source-edit allowance', () => {
  const feature = {
    id: 'quality', logicalRoot: 'quality:fixture', forbiddenPaths: ['.git'],
    metadata: { qualityReview: true, qualityFindingPolicy: 'repair-and-rereview', qualityRoot: 'quality:fixture', qualityContext: { verificationOutputPaths: ['.cardworld-local'] } },
  };
  const findings = [{ id: 'Q-unsafe', severity: 'P1', summary: 'Unsafe repair scope', affectedPaths: ['.cardworld-local/cache'], generatedOutputs: [], evidence: ['fixture'] }];
  assert.throws(() => repairsForFindings({ feature, findings }), error => error.code === 'QUALITY_REPAIR_SOURCE_OUTPUT_OVERLAP');
  findings[0].affectedPaths = ['.GIT/objects'];
  assert.throws(() => repairsForFindings({ feature, findings }), error => error.code === 'QUALITY_REPAIR_SOURCE_FORBIDDEN');
});

test('quality Profile keeps out-of-scope Findings open while authorizing in-scope repairs', () => {
  const feature = {
    id: 'quality', logicalRoot: 'quality:fixture', forbiddenPaths: ['tabletop-collection'],
    metadata: { stage: 'quality', qualityReview: true, qualityFindingPolicy: 'repair-and-rereview', qualityRoot: 'quality:fixture' },
  };
  const reviewed = { status: 'completed', findings: [finding, { ...finding, id: 'Q-external', affectedPaths: ['tabletop-collection/engine-artifact.lock.json'] }] };
  const verdict = createDeliveryLifecycleProfile().validateResult({ state: {}, feature, result: reviewed });
  assert.equal(verdict.ok, true);
  const repairs = createQualityFollowUpFeatures({ state: {}, feature, findings: reviewed.findings, result: reviewed });
  assert.deepEqual(repairs.map(item => item.metadata.repairFindingId), [finding.id]);
  assert.deepEqual(repairs[0].allowedPaths, ['README.md']);
});

test('batch quality budgets count reviews separately for each quality root', () => {
  const state = { profile: { config: { qualityReviewLimit: { mode: 'bounded', maxRechecks: 2 } } }, features: Array.from({ length: 10 }, (_, index) => ({ metadata: { qualityReview: true, qualityRoot: `item:${index}` } })) };
  assert.equal(qualityReviewBudgetExhausted(state, 'item:0'), false);
  state.features.push({ metadata: { qualityReview: true, qualityRoot: 'item:0' } }, { metadata: { qualityReview: true, qualityRoot: 'item:0' } });
  assert.equal(qualityReviewBudgetExhausted(state, 'item:0'), true);
  assert.equal(qualityReviewBudgetExhausted(state, 'item:1'), false);
});

test('new Run budget ignores audit history while a legacy immutable Run keeps target-scoped accounting', () => {
  const state = { profile: { config: { qualityReviewLimit: { mode: 'bounded', maxRechecks: 2 },
    priorQualityReviews: 3, qualityBudgetScope: 'run' } }, features: [{ metadata: { qualityReview: true } }] };
  assert.equal(qualityReviewBudgetExhausted(state), false);
  state.features.push({ metadata: { qualityReview: true } }, { metadata: { qualityReview: true } });
  assert.equal(qualityReviewBudgetExhausted(state), true);
  delete state.profile.config.qualityBudgetScope;
  state.features.length = 0;
  assert.equal(qualityReviewBudgetExhausted(state), true);
});

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
const forbiddenFinding = { ...finding, id: 'Q-E2E-FORBIDDEN', summary: 'Dependency outside this project remains open.', evidence: ['external lock version'], affectedPaths: ['tabletop-collection/engine-artifact.lock.json'], conflictKeys: [] };
const overlappingFinding = { ...finding, id: 'Q-E2E-003', summary: 'Second defect in the same file.', evidence: ['README.md:2'], generatedOutputs: ['generated/second'] };
const scopeFinding = { ...finding, id: 'Q-E2E-SCOPE', summary: 'Source and focused test both need a repair.', evidence: ['fixture/source.txt:1'], affectedPaths: ['fixture/source.txt'] };
const externalDiagnostic = { id: 'full-check-other', summary: 'Full check fails in OTHER.md.', evidence: ['host:full-check:OTHER.md:1'] };

const createHost = ({ workspace, failFirstWait = false, runningWaitCount = 0, failFirstInspect = false, failFirstConfirm = false, failFirstResult = false, repeatFindingOnce = false, repeatFindingCount = null, rejectRepairResultWithEdit = false, invalidRepairCheckpointOnce = false, externalDiagnosticOnce = false, overlappingFindings = false, missingDiagnosticDispositionOnce = false, cleanInitialReview = false, cleanAfterKnownRepair = false, includeForbiddenFinding = false, scopeBlockOnce = false, rejectProfileResultOnce = false, invalidTypedOutputOnce = null, advanceClockOnResult = null, now = () => new Date().toISOString() }) => {
  const agents = new Map();
  const stats = { spawnCount: 0, containCount: 0, terminalCount: 0, maxActive: 0, reconcileCount: 0 };
  let sequence = 0;
  let shouldFailWait = failFirstWait;
  let remainingRunningWaits = runningWaitCount;
  let shouldFailInspect = failFirstInspect;
  let shouldFailConfirm = failFirstConfirm;
  let shouldFailResult = failFirstResult;
  let remainingRepeatedFindings = repeatFindingCount ?? (repeatFindingOnce ? 1 : 0);
  let shouldRejectRepairCheckpoint = invalidRepairCheckpointOnce;
  let shouldReportExternalDiagnostic = externalDiagnosticOnce;
  let shouldConfirmExternalFinding = externalDiagnosticOnce;
  let shouldOmitDiagnosticDisposition = missingDiagnosticDispositionOnce;
  let shouldRejectProfileResult = rejectProfileResultOnce;
  let invalidTypedOutput = invalidTypedOutputOnce;
  let shouldScopeBlock = scopeBlockOnce;
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
        observedAt: now(),
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
        observedAt: now(),
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
      if (remainingRunningWaits > 0) {
        remainingRunningWaits -= 1;
        return { status: 'running', progress: 'working', receipt: { operation: 'wait', agentId: input.agentId } };
      }
      return { status: 'completed', progress: 'completed', receipt: { operation: 'wait', agentId: input.agentId } };
    },
    readVisibleResult: async input => {
      const task = agents.get(input.agentId);
      assert(task);
      advanceClockOnResult?.();
      const finish = output => {
        agents.delete(input.agentId);
        stats.terminalCount += 1;
        return output;
      };
      const stage = task.packet.feature.metadata.stage;
      if (stage === 'quality') {
        if (invalidTypedOutput) {
          const outputs = invalidTypedOutput === 'missing' ? {} : { quality: {
            schemaId: invalidTypedOutput === 'schema-id' ? 'wrong-schema' : 'delivery-quality-v1',
            value: invalidTypedOutput === 'value' ? {} : { findings: [] }, evidenceRefs: ['host:review'],
          } };
          invalidTypedOutput = null;
          return finish({ result: result({ summary: 'Review stored in an unaccepted file.', findings: [], knownFindingDispositions: cleanDisposition, outputs }),
            receipt: { operation: 'result', stage, observationRequestDigest: 'd'.repeat(64) } });
        }
        if (shouldRejectProfileResult) {
          shouldRejectProfileResult = false;
          return finish({ result: result({ summary: 'Profile rejected first review.', findings: [], knownFindingDispositions: cleanDisposition, outputs: { quality: { schemaId: 'delivery-quality-v1', value: { findings: [] }, evidenceRefs: ['host:review'] } } }), receipt: { operation: 'result', stage, observationRequestDigest: 'd'.repeat(64) } });
        }
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
        if (cleanInitialReview) return finish({ result: result({ summary: 'Initial quality review is clean.', findings: [], knownFindingDispositions: cleanDisposition, outputs: { quality: { schemaId: 'delivery-quality-v1', value: { findings: [] }, evidenceRefs: ['host:review'] } } }), receipt: { operation: 'result', stage } });
        if (cleanAfterKnownRepair && (await readFile(resolve(workspace, 'README.md'), 'utf8')).includes('verified repair'))
          return finish({ result: result({ summary: 'Known Finding was repaired before review.', findings: [], knownFindingDispositions: cleanDisposition, outputs: { quality: { schemaId: 'delivery-quality-v1', value: { findings: [] }, evidenceRefs: ['host:review'] } } }), receipt: { operation: 'result', stage } });
        const found = [...(scopeBlockOnce ? [scopeFinding] : overlappingFindings ? [finding, overlappingFinding] : [finding]), ...(includeForbiddenFinding ? [forbiddenFinding] : [])];
        return finish({ result: result({ summary: 'Initial full review found defects.', findings: found, knownFindingDispositions: scopeBlockOnce ? cleanDisposition : openDisposition, outputs: { quality: { schemaId: 'delivery-quality-v1', value: { findings: found }, evidenceRefs: ['host:review'] } } }), receipt: { operation: 'result', stage } });
      }
      if (stage === 'quality-repair') {
        if (scopeBlockOnce && task.packet.feature.metadata.repairFindingId === scopeFinding.id) {
          const sourcePath = resolve(workspace, 'fixture/source.txt');
          const testPath = resolve(workspace, 'fixture/behavior.test.txt');
          if (shouldScopeBlock) {
            shouldScopeBlock = false;
            await writeFile(sourcePath, 'partial source repair\n', 'utf8');
            return finish({ result: { status: 'blocked', summary: 'Focused verification requires a test change.', changedFiles: ['fixture/source.txt'],
              failureClass: 'scope-blocker', blocker: { kind: 'scope', summary: 'The focused test is outside this Dispatch.', repairCandidatePaths: ['fixture/behavior.test.txt'] } }, receipt: { operation: 'result', stage } });
          }
          assert(task.packet.feature.allowedPaths.includes('fixture/behavior.test.txt'));
          await writeFile(sourcePath, 'verified source repair\n', 'utf8');
          await writeFile(testPath, 'verified focused test\n', 'utf8');
          return finish({ result: result({ summary: 'Source and test repaired.', changedFiles: ['fixture/source.txt', 'fixture/behavior.test.txt'], checkpoint: 'scope-repair' }),
            runtimeEvidence: { verificationReceipts: [{ id: 'scope-repair', status: 'passed', evidence: ['fixture/behavior.test.txt'] }] }, receipt: { operation: 'result', stage } });
        }
        const repairPath = task.packet.feature.metadata.repairFindingId === externalFinding.id ? 'OTHER.md' : 'README.md';
        if (!task.repaired) {
          const current = await readFile(resolve(workspace, repairPath), 'utf8');
          task.changed = repeatFindingCount !== null || !current.includes('verified repair');
          if (task.changed) await writeFile(resolve(workspace, repairPath), `${current.trimEnd()}\nverified repair\n`, 'utf8');
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
      if (stage === 'quality-closeout') {
        assert(task.packet.feature.metadata.qualityCloseout?.priorRunId);
        const pinned = task.packet.feature.metadata.qualityCloseout;
        return finish({ result: result({ summary: 'Pinned quality evidence is ready for fresh final Gates.', checkpoint: 'closeout-evidence', outputs: { closeout: { schemaId: 'quality-closeout-evidence-v1', value: { priorRunId: pinned.priorRunId, sourceDigest: pinned.sourceDigest, ready: true }, evidenceRefs: ['host:closeout-evidence'] } } }), receipt: { operation: 'result', stage } });
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
      if (remainingRepeatedFindings > 0) {
        remainingRepeatedFindings -= 1;
        return finish({ result: result({ summary: 'First re-review found the same defect again.', findings: [finding], knownFindingDispositions: openDisposition, checkpoint: 'recheck' }), receipt: { operation: 'result', stage } });
      }
      return finish({ result: result({ summary: 'Post-repair full re-review is clean.', knownFindingDispositions: cleanDisposition, diagnosticDispositions: task.packet.feature.metadata.diagnostics?.length ? [{ id: externalDiagnostic.id, disposition: 'not-reproduced', evidence: ['fresh OTHER.md check after repair'] }] : undefined, checkpoint: 'recheck' }), receipt: { operation: 'result', stage } });
    },
  });
  return { adapter, agents, stats };
};

const setup = async ({ failFirstWait = false, runningWaitCount = 0, failFirstInspect = false, failFirstConfirm = false, failFirstResult = false, repeatFindingOnce = false, repeatFindingCount = null, rejectRepairResultWithEdit = false, invalidRepairCheckpointOnce = false, externalDiagnosticOnce = false, gateFailureUntilRepair = false, overlappingFindings = false, missingDiagnosticDispositionOnce = false, cleanInitialReview = false, cleanAfterKnownRepair = false, includeForbiddenFinding = false, scopeBlockOnce = false, rejectProfileResultOnce = false, invalidTypedOutputOnce = null, slowResultTransportMs = 0, preset = 'full', qualityReviewLimit = { mode: 'bounded', maxRechecks: 2 }, majorReleaseTargets = [] } = {}) => {
  const controlRoot = resolve(process.cwd());
  const parent = resolve(harnessTemporaryRoot(), 'quality-lifecycle-e2e');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'case-'));
  const workspace = resolve(root, 'CardWorld');
  const dataRoot = resolve(root, 'data');
  await mkdir(resolve(workspace, '.git'), { recursive: true });
  await writeFile(resolve(workspace, 'README.md'), '# Quality fixture\n', 'utf8');
  await writeFile(resolve(workspace, 'OTHER.md'), '# Separate fixture\n', 'utf8');
  if (scopeBlockOnce) {
    await mkdir(resolve(workspace, 'fixture'), { recursive: true });
    await writeFile(resolve(workspace, 'fixture/source.txt'), 'source defect\n', 'utf8');
    await writeFile(resolve(workspace, 'fixture/behavior.test.txt'), 'failing focused test\n', 'utf8');
  }
  const loadedEngine = await loadExtensionPack('./integrations/legacy-consumers/cardworld/index.mjs', { cwd: controlRoot, controlRoot });
  const engine = rejectProfileResultOnce ? {
    ...loadedEngine,
    profiles: [{ ...loadedEngine.profiles[0], validateResult: input => input.result.status === 'completed' && input.result.summary === 'Profile rejected first review.'
      ? { ok: false, reason: 'fixture-profile-evidence-incomplete' }
      : loadedEngine.profiles[0].validateResult(input) }],
  } : loadedEngine;
  const runtime = await loadExtensionPack('./integrations/codex/extensions/codex-runtime.mjs', { cwd: controlRoot, controlRoot });
  let clockMs = Date.now();
  const host = createHost({ workspace, failFirstWait, runningWaitCount, failFirstInspect, failFirstConfirm, failFirstResult, repeatFindingOnce, repeatFindingCount, rejectRepairResultWithEdit, invalidRepairCheckpointOnce, externalDiagnosticOnce, overlappingFindings, missingDiagnosticDispositionOnce, cleanInitialReview, cleanAfterKnownRepair, includeForbiddenFinding, scopeBlockOnce, rejectProfileResultOnce, invalidTypedOutputOnce,
    advanceClockOnResult: slowResultTransportMs ? () => { clockMs += slowResultTransportMs; } : null,
    ...(slowResultTransportMs ? { now: () => new Date(clockMs).toISOString() } : {}) });
  const create = () => createHarness({ controlRoot, dataRoot, releaseIdentity, strictProjectIdentity: false, extensions: [engine, runtime], agentAdapter: host.adapter,
    ...(slowResultTransportMs ? { now: () => new Date(clockMs).toISOString() } : {}) });
  const harness = await create();
  const descriptor = createCardWorldProjectDescriptor({ workspaceRoot: workspace, harness: releaseIdentity, qualityReviewLimit, majorReleaseTargets, knownFindingInventories: { 'V3.8.4': { version: '1.0', sources: [{ path: 'README.md', sha256: sha256('# Quality fixture\n') }], findings: [{ id: finding.id, severity: finding.severity, sourcePath: 'README.md' }] } } });
  descriptor.policy.qualityFindingPaths = scopeBlockOnce ? ['README.md', 'OTHER.md', 'fixture'] : ['README.md', 'OTHER.md'];
  if (scopeBlockOnce) descriptor.policy.actionPaths.implement = ['README.md', 'fixture'];
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

test('a clean initial quality review directly seals version clearance and development completion', async t => {
  const fixture = await setup({ cleanInitialReview: true });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const completed = await fixture.harness.executeVisibleLifecyclePlan(fixture.plan, { commandId: 'clean-quality-closeout', preflightReport: await fixture.harness.createExecutionReadinessReport(fixture.plan) });
  assert.equal(completed.status, 'closed');
  assert.deepEqual(completed.state.features.map(feature => feature.metadata.stage), ['quality']);
  assert.equal(completed.versionClearance.receipt.qualityConclusion.fullReviewPerformed, true);
  assert.equal(completed.versionClearance.receipt.status, 'development-complete');
  assert.equal(JSON.parse(await readFile(completed.versionClearance.file, 'utf8')).receiptDigest, completed.versionClearance.receipt.receiptDigest);
});

test('full quality repairs authoritative open Findings before its first review', async t => {
  const fixture = await setup({ preset: 'review-only', cleanAfterKnownRepair: true });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const prior = await fixture.harness.executeVisibleLifecyclePlan(fixture.plan, { commandId: 'known-before-review-prior',
    preflightReport: await fixture.harness.createExecutionReadinessReport(fixture.plan) });
  assert.equal(prior.state.findings[0].status, 'open');
  const plan = await fixture.harness.createLifecyclePlan({ projectId: prior.state.projectId, action: 'quality', target: 'V3.8.4',
    arguments: ['full'], extensionId: fixture.plan.extension.id, executionWorkspaceRoot: fixture.workspace });
  assert.deepEqual(plan.intent.qualityRepairInventory.findings.map(item => item.id), [finding.id]);
  assert.deepEqual(plan.run.features.map(feature => feature.metadata.stage), ['quality-repair', 'quality']);
  assert.deepEqual(plan.run.features[1].dependsOn, [plan.run.features[0].id]);
  const completed = await fixture.harness.executeVisibleLifecyclePlan(plan, { commandId: 'known-before-review-full',
    preflightReport: await fixture.harness.createExecutionReadinessReport(plan) });
  assert.equal(completed.status, 'closed');
  assert.equal(completed.state.findings[0].status, 'resolved');
  assert.deepEqual(completed.state.features.map(feature => feature.metadata.stage), ['quality-repair', 'quality']);
});

test('running Host waits do not consume the visible coordination round budget', async t => {
  const fixture = await setup({ cleanInitialReview: true, runningWaitCount: 3 });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const completed = await fixture.harness.executeVisibleLifecyclePlan(fixture.plan, {
    commandId: 'running-waits-budget',
    preflightReport: await fixture.harness.createExecutionReadinessReport(fixture.plan),
    maxRounds: 1,
  });
  assert.equal(completed.status, 'closed');
  assert.equal(completed.rounds.length, 1);
  assert.ok(completed.state.leases[0].heartbeatCount >= 4);
});

test('visible result observation renews the Lease after slow native transport', async t => {
  const fixture = await setup({ cleanInitialReview: true, slowResultTransportMs: 121000 });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const completed = await fixture.harness.executeVisibleLifecyclePlan(fixture.plan, { commandId: 'slow-native-result', preflightReport: await fixture.harness.createExecutionReadinessReport(fixture.plan) });
  assert.equal(completed.status, 'closed');
  assert.ok(completed.state.leases[0].heartbeatCount >= 2);
});

test('a Profile-rejected visible result is recorded and retried inside the original lifecycle', async t => {
  const fixture = await setup({ cleanInitialReview: true, rejectProfileResultOnce: true });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const completed = await fixture.harness.executeVisibleLifecyclePlan(fixture.plan, {
    commandId: 'profile-result-retry',
    preflightReport: await fixture.harness.createExecutionReadinessReport(fixture.plan),
  });
  assert.equal(completed.status, 'closed');
  assert.equal(fixture.host.stats.spawnCount, 2);
  assert.equal(completed.state.metadata.lifecycleInvocationId, 'profile-result-retry');
  const rejected = completed.state.submissions.find(item => item.result.blocker?.code === 'PROFILE_RESULT_REJECTED');
  assert(rejected);
  assert.match(rejected.result.summary, /fixture-profile-evidence-incomplete/);
  assert.equal(completed.state.leases.filter(lease => lease.status === 'active').length, 0);
  assert.equal(completed.state.features[0].state, 'completed');
});

for (const [invalidTypedOutputOnce, code] of [['missing', 'RESULT_OUTPUT_PORTS_MISMATCH'], ['schema-id', 'RESULT_OUTPUT_SCHEMA_ID_MISMATCH'], ['value', 'RESULT_OUTPUT_VALUE_SCHEMA_INVALID']]) {
  test(`a visible typed output rejection (${invalidTypedOutputOnce}) records failure before a same-Run retry`, async t => {
    const fixture = await setup({ cleanInitialReview: true, invalidTypedOutputOnce });
    t.after(() => rm(fixture.root, { recursive: true, force: true }));
    const completed = await fixture.harness.executeVisibleLifecyclePlan(fixture.plan, {
      commandId: `typed-output-retry-${invalidTypedOutputOnce}`,
      preflightReport: await fixture.harness.createExecutionReadinessReport(fixture.plan),
    });
    assert.equal(completed.status, 'closed');
    assert.equal(fixture.host.stats.spawnCount, 2);
    assert.equal(completed.state.runId, fixture.plan.run.runId);
    const rejected = completed.state.submissions.find(item => item.result.blocker?.code === code);
    assert(rejected);
    assert.equal(rejected.result.status, 'failed');
    assert.match(rejected.result.summary, /native JSON result itself/);
    assert.equal(rejected.result.outputs?.quality, undefined);
    assert.equal(completed.state.leases.filter(lease => lease.status === 'active').length, 0);
    assert.equal(completed.state.features[0].state, 'completed');
  });
}

test('visible quality lifecycle completes review, verified repair, fresh re-review, and closure', async t => {
  const fixture = await setup();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  assert.equal(fixture.plan.run.features[0].metadata.sourcePolicy, 'read-only');
  assert.equal(fixture.plan.run.features[0].metadata.qualityFindingPolicy, 'repair-and-rereview');
  assert.deepEqual(fixture.plan.run.features[0].metadata.qualityContext.verificationOutputPaths, ['.cardworld-local']);
  const preflight = await fixture.harness.createExecutionReadinessReport(fixture.plan);
  assert.equal(preflight.executionReady, true);
  assert.deepEqual(preflight.checks.find(check => check.id === 'quality-verification-paths')?.details.outputs, ['.cardworld-local']);
  const completed = await fixture.harness.executeVisibleLifecyclePlan(fixture.plan, { commandId: 'quality-e2e', preflightReport: preflight, maxConcurrency: 10 });
  for (const dispatch of completed.state.dispatches) assert.equal(sha256(await readFile(`${dispatch.outputRef}.dispatch-packet.json`, 'utf8')), dispatch.packetDigest);
  assert.equal(completed.rounds.every(round => round.physicalLimit === 1), true);
  assert.equal(completed.rounds.every(round => round.elapsedMs >= 0 && ['spawnMs', 'waitMs', 'resultMs'].every(key => round.timing[key] >= 0)), true);
  assertClosedQualityLoop(completed.state);
  assert.equal(completed.versionClearance.receipt.status, 'development-complete');
  const repair = completed.state.features.find(feature => feature.metadata.stage === 'quality-repair');
  assert.deepEqual(repair.metadata.verificationOutputPaths, ['.cardworld-local']);
  assert.deepEqual(repair.allowedPaths, ['README.md']);
  assert.equal(repair.generatedOutputs.includes('.cardworld-local'), true);
  assert.equal(repair.generatedOutputs.includes('tabletop-collection/.cardworld-local'), false);
});

test('mixed review repairs project source and records the external gate as a prerequisite', async t => {
  const fixture = await setup({ includeForbiddenFinding: true });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const run = await fixture.harness.executeVisibleLifecyclePlan(fixture.plan, { commandId: 'quality-mixed-boundary',
    preflightReport: await fixture.harness.createExecutionReadinessReport(fixture.plan) });
  assert.equal(run.status, 'closed');
  assert.equal(run.state.findings.find(item => item.id === finding.id)?.status, 'resolved');
  assert.equal(run.state.findings.some(item => item.id === forbiddenFinding.id), false);
  const classified = run.state.submissions.find(item => item.result?.deliveryPrerequisites?.length);
  assert.deepEqual(classified?.result.deliveryPrerequisites.map(item => item.id), [forbiddenFinding.id]);
  const classificationEvidence = JSON.parse((await fixture.harness.evidenceStore.read(classified.evidenceRefs[0])).bytes.toString('utf8'));
  assert.deepEqual(classificationEvidence.runtimeEvidence.qualityClassification.prerequisiteIds, [forbiddenFinding.id]);
  assert.deepEqual(run.state.features.map(feature => feature.metadata.stage), ['quality', 'quality-repair', 'quality-recheck']);
  assert.equal(fixture.host.stats.spawnCount, 3);
});

test('scope-blocked quality repair expands its recorded paths and completes the same Run', async t => {
  const fixture = await setup({ scopeBlockOnce: true });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const run = await fixture.harness.executeVisibleLifecyclePlan(fixture.plan, { commandId: 'quality-scope-continuation',
    preflightReport: await fixture.harness.createExecutionReadinessReport(fixture.plan) });
  assert.equal(run.status, 'closed');
  const repair = run.state.features.find(item => item.metadata.repairFindingId === scopeFinding.id);
  assert.equal(repair.state, 'completed');
  assert.deepEqual(repair.allowedPaths, ['fixture/source.txt', 'fixture/behavior.test.txt']);
  assert.equal(repair.metadata.scopeExtensions.length, 1);
  assert.equal(run.state.submissions.filter(item => item.featureId === repair.id).length, 2);
  assert.equal(run.state.events.some(item => item.type === 'feature.quality-scope-extended' && item.featureId === repair.id), true);
  assert.equal(run.state.findings.find(item => item.id === scopeFinding.id)?.status, 'resolved');
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
  assert.equal(completed.state.features.find(feature => feature.metadata.stage === 'quality-repair').generatedOutputs.includes('generated/second'), true);
  assert.equal(completed.state.findings.every(item => item.status === 'resolved'), true);
});

test('failed final Gate creates bounded diagnostic review and repair in the same Run', async t => {
  const fixture = await setup({ gateFailureUntilRepair: true, qualityReviewLimit: { mode: 'bounded', maxRechecks: 3 } });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  let startCalls = 0;
  const start = fixture.harness.startLifecyclePlan.bind(fixture.harness);
  fixture.harness.startLifecyclePlan = (...args) => { startCalls += 1; return start(...args); };
  const onGateProgress = () => {};
  const preflight = await fixture.harness.createExecutionReadinessReport(fixture.plan, { onGateProgress });
  const completed = await fixture.harness.executeVisibleLifecyclePlan(fixture.plan, { commandId: 'quality-gate-diagnostic', preflightReport: preflight, onGateProgress });
  assert.equal(completed.status, 'closed');
  assert.equal(startCalls, 1);
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

test('internal continuation runs the original Plan through quality closure with a new command ID', async t => {
  const fixture = await setup();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const first = await fixture.harness.createExecutionReadinessReport(fixture.plan);
  assert.equal(first.executionReady, true);
  const started = await fixture.harness.startLifecyclePlan(fixture.plan, { commandId: 'original-invocation', preflightReport: first });
  assert.equal(started.state.runId, fixture.plan.run.runId);
  const resume = await fixture.harness.createLifecycleResumePlan({ projectId: fixture.plan.project.id,
    runId: started.state.runId, executionWorkspaceRoot: fixture.workspace });
  assert.equal(resume.plan.planDigest, fixture.plan.planDigest);
  const readiness = await fixture.harness.createExecutionReadinessReport(resume.plan);
  assert.equal(readiness.executionReady, true);
  const completed = await fixture.harness.executeVisibleLifecyclePlan(resume.plan,
    { commandId: 'explicit-resume-invocation', preflightReport: readiness, resume });
  assert.equal(completed.status, 'closed');
  assert.equal(completed.state.runId, started.state.runId);
  assert.equal(fixture.host.stats.spawnCount, 3);
  assert.equal((await fixture.harness.authorityStore.list(fixture.plan.project.id)).filter(run => run.runId === started.state.runId).length, 1);
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
  const completed = await restartedHarness.executeVisibleLifecyclePlan(fixture.plan, { commandId: 'quality-before-restart', preflightReport: resumedPreflight, maxConcurrency: 1 });
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
  assert.equal(stopped.blockedFeatures.length, 1);
  assert.equal(stopped.blockedFeatures[0].id, stopped.state.features[0].id);
  assert.deepEqual(stopped.blockedFeatures[0].allowedPaths, []);
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

test('default quality budget ends one Run after two re-reviews and permits a new bounded quality Run', async t => {
  const fixture = await setup({ repeatFindingCount: 2 });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const preflight = await fixture.harness.createExecutionReadinessReport(fixture.plan);
  const stopped = await fixture.harness.executeVisibleLifecyclePlan(fixture.plan, { commandId: 'quality-budget-default', preflightReport: preflight });
  assert.equal(stopped.status, 'incomplete');
  assert.equal(stopped.reason, 'quality-review-limit-reached');
  assert.equal(stopped.state.status, 'incomplete');
  assert.equal(stopped.state.metadata.terminalOutcome.reason, 'quality-review-limit-reached');
  assert.equal(stopped.versionClearance, undefined);
  await assert.rejects(() => fixture.harness.kernel.closeRun(stopped.state.projectId, stopped.state.runId, {},
    { expectedRevision: stopped.state.revision, commandId: 'quality-incomplete-cannot-close' }),
  error => error.code === 'RUN_TERMINAL');
  assert.equal(stopped.state.features.filter(feature => feature.metadata?.qualityReview === true).length, 3);
  assert.equal(fixture.host.stats.spawnCount, 6);
  const next = await fixture.harness.createLifecyclePlan({ projectId: stopped.state.projectId, action: 'quality', target: 'V3.8.4', arguments: ['full'], extensionId: 'cardworld-engine-profile', executionWorkspaceRoot: fixture.workspace });
  assert.equal(next.run.profileConfig.priorQualityReviews, 3);
  assert.equal(next.run.profileConfig.qualityBudgetScope, 'run');
  assert.notEqual(next.run.runId, stopped.state.runId);
  assert.equal((await fixture.harness.createExecutionReadinessReport(next)).executionReady, true);
  const completed = await fixture.harness.executeVisibleLifecyclePlan(next, { commandId: 'quality-budget-next-run',
    preflightReport: await fixture.harness.createExecutionReadinessReport(next) });
  assert.equal(completed.status, 'closed');
  assert.equal(completed.state.features.filter(feature => feature.metadata?.qualityReview === true).length <= 3, true);
  assert.equal(completed.versionClearance.receipt.status, 'development-complete');
});

test('an idle quality Run with an unreconstructable plan records failure evidence before a new round', async t => {
  const fixture = await setup({ preset: 'review-only' });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const prior = await fixture.harness.executeVisibleLifecyclePlan(fixture.plan, { commandId: 'quality-prior-plan',
    preflightReport: await fixture.harness.createExecutionReadinessReport(fixture.plan) });
  assert.equal(prior.state.status, 'closure-blocked');
  const stalePlan = Object.assign(new Error('Pinned plan identity changed.'), { code: 'LIFECYCLE_RESUME_IDENTITY_STALE' });
  const assessed = await retireUnresumableQualityRun({ harness: fixture.harness, state: prior.state,
    error: stalePlan, commandId: 'quality-read-only-assessment', dryRun: true });
  assert.equal(assessed.status, 'failed');
  assert.equal((await fixture.harness.authorityStore.read(prior.state.projectId, prior.state.runId)).revision,
    prior.state.revision);
  const result = await retireUnresumableQualityRun({ harness: fixture.harness, state: prior.state,
    error: stalePlan,
    commandId: 'quality-next-request' });
  assert.equal(result.state.status, 'failed');
  assert.equal(result.state.metadata.terminalOutcome.reason, 'LIFECYCLE_RESUME_IDENTITY_STALE');
  assert.equal(result.state.metadata.terminalOutcome.evidenceRefs.length, 1);
  const next = await fixture.harness.createLifecyclePlan({ projectId: result.state.projectId, action: 'quality',
    target: 'V3.8.4', arguments: ['review-only'], extensionId: 'cardworld-engine-profile', executionWorkspaceRoot: fixture.workspace });
  assert.equal(next.run.profileConfig.qualityBudgetScope, 'run');
  assert.notEqual(next.run.runId, result.state.runId);
  await assert.rejects(() => retireUnresumableQualityRun({ harness: fixture.harness,
    state: { ...result.state, status: 'running', leases: [{ status: 'active' }] },
    error: Object.assign(new Error('Pinned plan identity changed.'), { code: 'LIFECYCLE_RESUME_IDENTITY_STALE' }),
    commandId: 'quality-active-request' }), error => error.code === 'QUALITY_FAILURE_ACTIVE_EFFECT');
});

test('repair-known fixes the frozen open ledger without dispatching a reviewer', async t => {
  const fixture = await setup({ preset: 'review-only' });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const firstPreflight = await fixture.harness.createExecutionReadinessReport(fixture.plan);
  const reviewed = await fixture.harness.executeVisibleLifecyclePlan(fixture.plan, { commandId: 'quality-known-review', preflightReport: firstPreflight });
  assert.equal(reviewed.state.findings[0].status, 'open');
  const plan = await fixture.harness.createLifecyclePlan({ projectId: reviewed.state.projectId, action: 'quality', target: 'V3.8.4', arguments: ['repair-known'], extensionId: 'cardworld-engine-profile', executionWorkspaceRoot: fixture.workspace });
  assert.equal(plan.stopCondition.type, 'routine-version-exit');
  assert.equal(plan.run.features.every(feature => feature.metadata.stage === 'quality-repair' && feature.metadata.repairOnly === true), true);
  assert.equal(plan.run.features.every(feature => feature.metadata.qualityReview !== true), true);
  const preflight = await fixture.harness.createExecutionReadinessReport(plan);
  const repaired = await fixture.harness.executeVisibleLifecyclePlan(plan, { commandId: 'quality-known-repair', preflightReport: preflight });
  const priorReview = await fixture.harness.authorityStore.read(reviewed.state.projectId, reviewed.state.runId);
  assert.equal(priorReview.status, 'superseded');
  assert.equal(priorReview.metadata.supersededByRunId, repaired.state.runId);
  assert.equal(repaired.status, 'attention-required');
  assert.equal(repaired.reason, 'routine-version-exit-decision-required');
  assert.equal(repaired.state.findings.every(item => item.status === 'resolved'), true);
  assert.equal(repaired.state.features.some(feature => feature.metadata?.qualityReview === true), false);
  const decided = await fixture.harness.kernel.recordDecision(repaired.state.projectId, repaired.state.runId, { id: 'routine-version-exit', actor: 'test-user', decision: 'approved' }, { expectedRevision: repaired.state.revision, commandId: 'quality-known-exit-decision' });
  const resumedPreflight = await fixture.harness.createExecutionReadinessReport(plan);
  const closed = await fixture.harness.executeVisibleLifecyclePlan(plan, { commandId: 'quality-known-repair', preflightReport: resumedPreflight });
  assert.equal(closed.status, 'closed');
  assert.equal(closed.state.revision > decided.state.revision, true);
  const receipt = JSON.parse(await readFile(closed.state.receipts.find(item => item.kind === 'run-closure').file, 'utf8'));
  assert.equal(receipt.qualityConclusion.mode, 'known-findings-repair');
  assert.equal(receipt.qualityConclusion.fullReviewPerformed, false);
  assert.equal(receipt.versionExit.status, 'ready-for-next-version');
  assert.equal(receipt.lifecycleInvocation.startCount, 1);
});

test('independent closeout bypasses exhausted review budget and seals version clearance', async t => {
  const fixture = await setup({ preset: 'review-only', qualityReviewLimit: { mode: 'bounded', maxRechecks: 0 } });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const reviewed = await fixture.harness.executeVisibleLifecyclePlan(fixture.plan, { commandId: 'closeout-prior-review', preflightReport: await fixture.harness.createExecutionReadinessReport(fixture.plan) });
  const repairPlan = await fixture.harness.createLifecyclePlan({ projectId: reviewed.state.projectId, action: 'quality', target: 'V3.8.4', arguments: ['repair-known'], extensionId: 'cardworld-engine-profile', executionWorkspaceRoot: fixture.workspace });
  const repaired = await fixture.harness.executeVisibleLifecyclePlan(repairPlan, { commandId: 'closeout-prior-repair', preflightReport: await fixture.harness.createExecutionReadinessReport(repairPlan) });
  assert.equal(repaired.reason, 'routine-version-exit-decision-required');
  assert.equal(repaired.state.findings[0].status, 'resolved');
  const zeroRepair = await fixture.harness.createLifecyclePlan({ projectId: reviewed.state.projectId, action: 'quality', target: 'V3.8.4', arguments: ['repair-known'], extensionId: 'cardworld-engine-profile', executionWorkspaceRoot: fixture.workspace });
  assert.deepEqual(zeroRepair.intent.qualityRepairInventory.findings, []);
  assert.deepEqual(zeroRepair.run.features.map(feature => feature.metadata.stage), ['quality-closeout']);
  const closeout = await fixture.harness.createLifecyclePlan({ projectId: reviewed.state.projectId, action: 'quality', target: 'V3.8.4', arguments: ['closeout'], extensionId: 'cardworld-engine-profile', executionWorkspaceRoot: fixture.workspace });
  assert.equal(closeout.run.profileConfig.priorQualityReviews, 1);
  assert.equal(closeout.run.profileConfig.closeoutOnly, true);
  assert.deepEqual(closeout.run.features.map(feature => feature.metadata.stage), ['quality-closeout']);
  const pending = await fixture.harness.executeVisibleLifecyclePlan(closeout, { commandId: 'quality-closeout', preflightReport: await fixture.harness.createExecutionReadinessReport(closeout) });
  assert.equal(pending.reason, 'routine-version-exit-decision-required');
  assert.equal(pending.state.features.some(feature => feature.metadata.qualityReview === true), false);
  await fixture.harness.kernel.recordDecision(pending.state.projectId, pending.state.runId, { id: 'routine-version-exit', actor: 'test-user', decision: 'approved' }, { expectedRevision: pending.state.revision, commandId: 'quality-closeout-exit-decision' });
  const closed = await fixture.harness.executeVisibleLifecyclePlan(closeout, { commandId: 'quality-closeout', preflightReport: await fixture.harness.createExecutionReadinessReport(closeout) });
  assert.equal(closed.status, 'closed');
  const receipt = JSON.parse(await readFile(closed.state.receipts.find(item => item.kind === 'run-closure').file, 'utf8'));
  assert.equal(receipt.qualityConclusion.fullReviewPerformed, false);
  assert.equal(closed.versionClearance.receipt.qualityConclusion.mode, 'evidence-backed-closeout');
  assert.deepEqual(closed.versionClearance.receipt.qualityConclusion.verifiedFindingIds, [finding.id]);
  assert.equal(closed.versionClearance.receipt.status, 'development-complete');
  const repeated = await fixture.harness.executeVisibleLifecyclePlan(closeout, { commandId: 'quality-closeout', preflightReport: await fixture.harness.createExecutionReadinessReport(closeout) });
  assert.equal(repeated.status, 'closed');
  assert.equal(repeated.versionClearance.receipt.receiptDigest, closed.versionClearance.receipt.receiptDigest);
  const closureFile = closed.state.receipts.find(item => item.kind === 'run-closure').file;
  const altered = JSON.parse(await readFile(closureFile, 'utf8'));
  altered.sourceDigest = '0'.repeat(64);
  await writeFile(closureFile, JSON.stringify(altered), 'utf8');
  await assert.rejects(
    async () => fixture.harness.executeVisibleLifecyclePlan(closeout, { commandId: 'quality-closeout', preflightReport: await fixture.harness.createExecutionReadinessReport(closeout) }),
    error => error.code === 'VERSION_CLOSURE_RECEIPT_MISMATCH',
  );
});

test('repair-known with no open Findings plans closeout without granting a duplicate active Run', async t => {
  const fixture = await setup({ preset: 'review-only' });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const reviewed = await fixture.harness.executeVisibleLifecyclePlan(fixture.plan, { commandId: 'zero-repair-review', preflightReport: await fixture.harness.createExecutionReadinessReport(fixture.plan) });
  const first = await fixture.harness.createLifecyclePlan({ projectId: reviewed.state.projectId, action: 'quality', target: 'V3.8.4', arguments: ['repair-known'], extensionId: 'cardworld-engine-profile', executionWorkspaceRoot: fixture.workspace });
  const repaired = await fixture.harness.executeVisibleLifecyclePlan(first, { commandId: 'zero-repair-first', preflightReport: await fixture.harness.createExecutionReadinessReport(first) });
  assert.equal(repaired.reason, 'routine-version-exit-decision-required');
  const followUp = await fixture.harness.createLifecyclePlan({ projectId: reviewed.state.projectId, action: 'quality', target: 'V3.8.4', arguments: ['repair-known'], extensionId: 'cardworld-engine-profile', executionWorkspaceRoot: fixture.workspace });
  assert.equal(followUp.run.profileConfig.closeoutOnly, true);
  assert.deepEqual(followUp.run.features.map(feature => feature.metadata.stage), ['quality-closeout']);
  const readiness = await fixture.harness.createExecutionReadinessReport(followUp);
  assert.equal(readiness.executionReady, false);
  assert.equal(readiness.checks.find(check => check.id === 'run-lineage').issues[0].code, 'EXISTING_RUN_REQUIRES_INTERNAL_CONTINUATION');
});

test('independent closeout rejects open Findings and source drift before creating a Run', async t => {
  const fixture = await setup({ preset: 'review-only' });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const reviewed = await fixture.harness.executeVisibleLifecyclePlan(fixture.plan, { commandId: 'closeout-guard-review', preflightReport: await fixture.harness.createExecutionReadinessReport(fixture.plan) });
  await assert.rejects(
    () => fixture.harness.createLifecyclePlan({ projectId: reviewed.state.projectId, action: 'quality', target: 'V3.8.4', arguments: ['closeout'], extensionId: 'cardworld-engine-profile', executionWorkspaceRoot: fixture.workspace }),
    error => error.code === 'QUALITY_CLOSEOUT_FINDINGS_OPEN',
  );
  const repair = await fixture.harness.createLifecyclePlan({ projectId: reviewed.state.projectId, action: 'quality', target: 'V3.8.4', arguments: ['repair-known'], extensionId: 'cardworld-engine-profile', executionWorkspaceRoot: fixture.workspace });
  await fixture.harness.executeVisibleLifecyclePlan(repair, { commandId: 'closeout-guard-repair', preflightReport: await fixture.harness.createExecutionReadinessReport(repair) });
  await writeFile(resolve(fixture.workspace, 'README.md'), '# Source changed after repair\n', 'utf8');
  await assert.rejects(
    () => fixture.harness.createLifecyclePlan({ projectId: reviewed.state.projectId, action: 'quality', target: 'V3.8.4', arguments: ['closeout'], extensionId: 'cardworld-engine-profile', executionWorkspaceRoot: fixture.workspace }),
    error => error.code === 'QUALITY_CLOSEOUT_SOURCE_DRIFT',
  );
});

test('independent closeout never issues version clearance when a final Gate fails', async t => {
  const fixture = await setup({ preset: 'review-only', gateFailureUntilRepair: true });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const onGateProgress = () => {};
  const initialReadiness = await fixture.harness.createExecutionReadinessReport(fixture.plan, { onGateProgress });
  assert.equal(initialReadiness.executionReady, true, JSON.stringify(initialReadiness.checks.filter(check => !check.ready)));
  const reviewed = await fixture.harness.executeVisibleLifecyclePlan(fixture.plan, { commandId: 'closeout-gate-review', preflightReport: initialReadiness, onGateProgress });
  const repair = await fixture.harness.createLifecyclePlan({ projectId: reviewed.state.projectId, action: 'quality', target: 'V3.8.4', arguments: ['repair-known'], extensionId: 'cardworld-engine-profile', executionWorkspaceRoot: fixture.workspace });
  const repaired = await fixture.harness.executeVisibleLifecyclePlan(repair, { commandId: 'closeout-gate-repair', preflightReport: await fixture.harness.createExecutionReadinessReport(repair, { onGateProgress }), onGateProgress });
  assert.equal(repaired.reason, 'final-gates-not-passed');
  const closeout = await fixture.harness.createLifecyclePlan({ projectId: reviewed.state.projectId, action: 'quality', target: 'V3.8.4', arguments: ['closeout'], extensionId: 'cardworld-engine-profile', executionWorkspaceRoot: fixture.workspace });
  const stopped = await fixture.harness.executeVisibleLifecyclePlan(closeout, { commandId: 'closeout-gate-fail', preflightReport: await fixture.harness.createExecutionReadinessReport(closeout, { onGateProgress }), onGateProgress });
  assert.equal(stopped.reason, 'final-gates-not-passed');
  assert.equal(stopped.state.receipts.some(item => item.kind === 'run-closure'), false);
});

test('declared major release can exceed the routine re-review limit in one invocation', async t => {
  const fixture = await setup({ preset: 'release-exhaustive', repeatFindingCount: 2, qualityReviewLimit: { mode: 'bounded', maxRechecks: 0 }, majorReleaseTargets: ['V3.8.4'] });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  assert.deepEqual(fixture.plan.run.profileConfig.qualityReviewLimit, { mode: 'unbounded' });
  const preflight = await fixture.harness.createExecutionReadinessReport(fixture.plan);
  const reviewed = await fixture.harness.executeVisibleLifecyclePlan(fixture.plan, { commandId: 'major-release-once', preflightReport: preflight });
  assert.equal(reviewed.status, 'attention-required');
  assert.equal(reviewed.reason, 'user-code-review-required');
  await fixture.harness.kernel.recordDecision(reviewed.state.projectId, reviewed.state.runId, { id: 'user-code-review', actor: 'test-user', decision: 'approved' }, { expectedRevision: reviewed.state.revision, commandId: 'major-release-user-review' });
  const resumedPreflight = await fixture.harness.createExecutionReadinessReport(fixture.plan);
  const completed = await fixture.harness.executeVisibleLifecyclePlan(fixture.plan, { commandId: 'major-release-once', preflightReport: resumedPreflight });
  assert.equal(completed.status, 'closed');
  assert.equal(completed.state.features.filter(feature => feature.metadata?.qualityReview === true).length, 4);
  const receipt = JSON.parse(await readFile(completed.state.receipts.find(item => item.kind === 'run-closure').file, 'utf8'));
  assert.equal(receipt.qualityConclusion.mode, 'major-release-exhaustive');
  assert.equal(receipt.lifecycleInvocation.startCount, 1);
});

test('unbounded major release stops when a repair makes no source progress', async t => {
  const fixture = await setup({ preset: 'release-exhaustive', repeatFindingOnce: true, majorReleaseTargets: ['V3.8.4'] });
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const preflight = await fixture.harness.createExecutionReadinessReport(fixture.plan);
  const stopped = await fixture.harness.executeVisibleLifecyclePlan(fixture.plan, { commandId: 'major-release-stalled', preflightReport: preflight });
  assert.equal(stopped.status, 'attention-required');
  assert.equal(stopped.reason, 'quality-review-no-progress');
  assert.equal(stopped.state.features.filter(feature => feature.metadata?.qualityReview === true).length, 2);
});
