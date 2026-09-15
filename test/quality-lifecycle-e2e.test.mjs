import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHarness } from '../src/app/harness.mjs';
import { createCardWorldProjectDescriptor } from '../src/consumers/cardworld-engine.mjs';
import { loadExtensionPack } from '../src/extensions/contract.mjs';
import { createVisibleHostAdapter } from '../src/plugins/runtime/visible-host-adapter.mjs';
import { harnessTemporaryRoot } from '../src/write-boundary.mjs';

const releaseIdentity = { version: '1.0.0', artifactDigest: 'a'.repeat(64), verified: true };

const result = ({ summary, findings = [], changedFiles = [], checkpoint = 'review' }) => ({
  status: 'completed',
  summary,
  checkpoints: [{ id: checkpoint, status: 'passed', summary, evidence: [`host:${checkpoint}`] }],
  made: [],
  notMade: [],
  changedFiles,
  observations: [],
  findings,
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

const createHost = ({ workspace, failFirstWait = false, repeatFindingOnce = false }) => {
  const agents = new Map();
  let sequence = 0;
  let shouldFailWait = failFirstWait;
  let shouldRepeatFinding = repeatFindingOnce;
  const adapter = createVisibleHostAdapter({
    provider: 'quality-e2e-host',
    inspectVisibleAgent: async expected => ({
      verified: true,
      status: 'running',
      assertionId: `assertion:${expected.agentId}`,
      observedAt: new Date().toISOString(),
      agentId: expected.agentId,
      dispatchId: expected.dispatchId,
      packetDigest: expected.packetDigest,
      promptDigest: expected.promptDigest,
      visibility: { mode: 'user-visible', surface: expected.surface, inspectRef: expected.inspectRef },
    }),
    spawnVisibleAgent: async input => {
      const agentId = `visible-e2e-${++sequence}`;
      const visibility = { mode: 'user-visible', surface: 'codex-task', inspectRef: `task:${agentId}` };
      agents.set(agentId, { ...structuredClone(input), visibility, repaired: false });
      return { agentId, visibility, receipt: { operation: 'spawn', agentId } };
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
      const stage = task.packet.feature.metadata.stage;
      if (stage === 'quality') {
        return { result: result({ summary: 'Initial full review found one defect.', findings: [finding] }), receipt: { operation: 'result', stage } };
      }
      if (stage === 'quality-repair') {
        if (!task.repaired) {
          const current = await readFile(resolve(workspace, 'README.md'), 'utf8');
          await writeFile(resolve(workspace, 'README.md'), `${current.trimEnd()}\nverified repair\n`, 'utf8');
          task.repaired = true;
        }
        return {
          result: result({ summary: 'Finding repaired and verified.', changedFiles: ['README.md'], checkpoint: 'repair-verification' }),
          runtimeEvidence: { verificationReceipts: [{ id: 'focused-check', status: 'passed', evidence: ['README.md'] }] },
          receipt: { operation: 'result', stage },
        };
      }
      assert.equal(stage, 'quality-recheck');
      if (shouldRepeatFinding) {
        shouldRepeatFinding = false;
        return { result: result({ summary: 'First re-review found the same defect again.', findings: [finding], checkpoint: 'recheck' }), receipt: { operation: 'result', stage } };
      }
      return { result: result({ summary: 'Post-repair full re-review is clean.', checkpoint: 'recheck' }), receipt: { operation: 'result', stage } };
    },
  });
  return { adapter, agents };
};

const setup = async ({ failFirstWait = false, repeatFindingOnce = false } = {}) => {
  const controlRoot = resolve(process.cwd());
  const parent = resolve(harnessTemporaryRoot(), 'quality-lifecycle-e2e');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'case-'));
  const workspace = resolve(root, 'CardWorld');
  const dataRoot = resolve(root, 'data');
  await mkdir(resolve(workspace, '.git'), { recursive: true });
  await writeFile(resolve(workspace, 'README.md'), '# Quality fixture\n', 'utf8');
  const engine = await loadExtensionPack('./src/consumers/cardworld-engine.mjs', { cwd: controlRoot, controlRoot });
  const runtime = await loadExtensionPack('./src/extensions/codex-runtime.mjs', { cwd: controlRoot, controlRoot });
  const host = createHost({ workspace, failFirstWait, repeatFindingOnce });
  const create = () => createHarness({ controlRoot, dataRoot, releaseIdentity, strictProjectIdentity: false, extensions: [engine, runtime], agentAdapter: host.adapter });
  const harness = await create();
  const descriptor = createCardWorldProjectDescriptor({ workspaceRoot: workspace, harness: releaseIdentity });
  descriptor.gateRecipes = [];
  descriptor.extensions = descriptor.extensions.map(item => ({ ...item, digest: item.id === engine.id ? engine.digest : runtime.digest }));
  await harness.projectRegistry.register(descriptor, { expectedRevision: 0, commandId: 'quality-e2e-project' });
  const plan = await harness.createLifecyclePlan({ projectId: descriptor.id, action: 'quality', target: 'V3.8.4', arguments: ['full'], extensionId: engine.id, executionWorkspaceRoot: workspace });
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
  const preflight = await fixture.harness.createExecutionReadinessReport(fixture.plan);
  assert.equal(preflight.executionReady, true);
  const completed = await fixture.harness.executeVisibleLifecyclePlan(fixture.plan, { commandId: 'quality-e2e', preflightReport: preflight, maxConcurrency: 10 });
  assert.equal(completed.rounds.every(round => round.physicalLimit === 1), true);
  assertClosedQualityLoop(completed.state);
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
