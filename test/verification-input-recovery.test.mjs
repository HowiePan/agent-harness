import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { captureWorkspace } from '../src/common/workspace-snapshot.mjs';
import { digestJson } from '../src/common/canonical.mjs';
import { HarnessKernel } from '../src/kernel/kernel.mjs';
import { inspectVerificationInputRepairs, applyVerificationInputRepair, INPUT_BINDING_BLOCKER } from '../src/application/verification-input-recovery.mjs';
import { selectBlockedResumeFeature } from '../src/application/lifecycle-resume.mjs';
import { makeFixture } from './test-support.mjs';

const fixture = async t => {
  const f = await makeFixture(); t.after(f.cleanup);
  await mkdir(resolve(f.workspace, 'tests/suites'), { recursive: true });
  await writeFile(resolve(f.workspace, 'Cargo.toml'), '[[test]]\nname="suite"\npath="tests/suites/suite.rs"\n');
  await writeFile(resolve(f.workspace, 'tests/suites/suite.rs'), 'test body');
  const check = { id: 'behavior', command: ['cargo', 'test', '--test', 'suite'], inputs: ['Cargo.toml', 'tests/suite.rs'], outputs: [], covers: ['behavior'] };
  const feature = { id: 'owner', state: 'blocked', logicalRoot: 'owner', allowedPaths: ['Cargo.toml', 'tests'], forbiddenPaths: [], dependsOn: [],
    metadata: { stage: 'implementation', deliveryBatch: { checks: [check] } } };
  const submission = { submissionId: 's1', featureId: feature.id, outputSourceDigest: (await captureWorkspace(f.workspace)).digest,
    evidenceRefs: ['evidence:original'], attemptBudgetKey: 'owner:external-blocker',
    result: { status: 'blocked', failureClass: 'external-blocker', blocker: { kind: 'prerequisite', code: INPUT_BINDING_BLOCKER } } };
  const state = { projectId: f.projectId, runId: 'fixture', revision: 1, epoch: 1, generation: 1, sourceDigest: submission.outputSourceDigest,
    status: 'all-remaining-blocked', profile: { id: 'fixture' }, metadata: { workspace: { root: f.workspace } },
    features: [feature], submissions: [submission], attempts: { 'owner:external-blocker': { failures: 1, limit: 3, exhausted: false } },
    leases: [], dispatches: [], findings: [], events: [], decisions: [] };
  const authorityStore = { async transact(_project, _run, command, mutate) {
    assert.equal(command.expectedRevision, state.revision);
    const result = mutate(state); state.revision += 1; return { result, state };
  } };
  const kernel = new HarnessKernel({ authorityStore, profiles: new Map([['fixture', { canClose: () => ({ ok: true }) }]]) });
  return { ...f, state, feature, submission, kernel, project: { workspace: { root: f.workspace, excluded: [] } } };
};

test('verified input repair reopens exact blocked Feature via evidence and Kernel without changing plan, scope or budget', async t => {
  const f = await fixture(t); const before = digestJson({ scope: f.feature.allowedPaths, metadata: f.feature.metadata, attempts: f.state.attempts });
  assert.throws(() => selectBlockedResumeFeature(f.state), { code: 'LIFECYCLE_RESUME_BLOCKER_REQUIRES_REVIEW' });
  const repairs = await inspectVerificationInputRepairs(f.state, f.workspace);
  assert.equal(repairs.length, 1); assert.equal(selectBlockedResumeFeature(f.state, { inputBindingRepairs: repairs }), 'owner');
  await applyVerificationInputRepair({ ...f, featureId: 'owner', evidenceStore: f.harness.evidenceStore, commandId: 'repair' });
  assert.equal(f.feature.state, 'pending'); assert.equal(f.state.decisions.length, 1);
  assert.equal(f.state.decisions[0].actor, 'harness'); assert.equal(f.state.decisions[0].decision, 'verified');
  const proof = await f.harness.evidenceStore.read(f.state.decisions[0].evidenceRef);
  assert.equal(JSON.parse(proof.bytes).resolutions[0].bindings[0].resolvedPath, 'tests/suites/suite.rs');
  assert.equal(digestJson({ scope: f.feature.allowedPaths, metadata: f.feature.metadata, attempts: f.state.attempts }), before);
  assert.equal(await applyVerificationInputRepair({ ...f, featureId: 'owner', evidenceStore: f.harness.evidenceStore, commandId: 'again' }), null);
});

test('crash between proof and reopen resumes from the same proof and forbids another blocked submission reusing it', async t => {
  const f = await fixture(t); const reopen = f.kernel.reopenFeature.bind(f.kernel);
  f.kernel.reopenFeature = async () => { throw new Error('simulated crash'); };
  const args = { ...f, featureId: 'owner', evidenceStore: f.harness.evidenceStore, commandId: 'repair' };
  await assert.rejects(applyVerificationInputRepair(args), /simulated crash/);
  assert.equal(f.state.decisions.length, 1); f.kernel.reopenFeature = reopen;
  await applyVerificationInputRepair(args); assert.equal(f.feature.state, 'pending'); assert.equal(f.state.decisions.length, 1);
  f.feature.state = 'blocked'; f.state.submissions.push({ ...f.submission, submissionId: 's2' });
  assert.deepEqual(await inspectVerificationInputRepairs(f.state, f.workspace), []);
});

test('automation cannot reopen exhausted, permission, unproved, unrelated, stale-source or out-of-scope blockers', async t => {
  const f = await fixture(t); const baseline = structuredClone(f.state);
  for (const mutate of [s => s.attempts['owner:external-blocker'].exhausted = true,
    s => s.submissions[0].result.blocker.kind = 'permission',
    s => s.submissions[0].result.blocker.code = 'another-blocker',
    s => s.submissions[0].evidenceRefs = [], s => s.sourceDigest = 'other',
    s => s.features[0].allowedPaths = ['Cargo.toml'],
    s => s.leases.push({ featureId: 'owner', status: 'active' })]) {
    const state = structuredClone(baseline); mutate(state);
    assert.deepEqual(await inspectVerificationInputRepairs(state, f.workspace), []);
  }
  await writeFile(resolve(f.workspace, 'new-source.txt'), 'unauthorized drift');
  await assert.rejects(applyVerificationInputRepair({ ...f, featureId: 'owner', evidenceStore: f.harness.evidenceStore, commandId: 'drift' }),
    { code: 'WORKSPACE_SOURCE_DRIFT' });
  assert.equal(f.state.decisions.length, 0);
});
