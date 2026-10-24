import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digestJson } from '../src/common/canonical.mjs';
import { captureWorkspace } from '../src/common/workspace-snapshot.mjs';
import { assertEnvironmentReviewScope, environmentBlockedFeatures, reviewDevelopmentEnvironment } from '../src/application/development-environment-review.mjs';
import { makeFixture } from './test-support.mjs';

const H = 'a'.repeat(64);
const fixture = async () => {
  const f = await makeFixture();
  const source = await captureWorkspace(f.workspace);
  const feature = { id: 'one', logicalRoot: 'implement:one', state: 'blocked', metadata: { stage: 'implementation' } };
  const result = { status: 'blocked', failureClass: 'environment-blocker', changedFiles: [],
    blocker: { kind: 'environment', code: 'executable-access-denied', summary: 'Cannot launch tool' },
    deliveryPrerequisites: [{ affectedPaths: [process.execPath] }] };
  const evidence = await f.harness.evidenceStore.put({ result }, { projectId: f.projectId,
    runId: 'run', epoch: 1, generation: 1, featureId: feature.id, dispatchId: 'dispatch', sourceDigest: source.digest,
    artifactDigest: H, policyDigest: H, pluginSetDigest: H });
  const body = { featureId: feature.id, submissionId: 'submission', dispatchId: 'dispatch',
    evidenceRefs: [evidence.ref], result };
  const submission = { ...body, submissionDigest: digestJson(body) };
  const state = { projectId: f.projectId, runId: 'run', status: 'ready', revision: 3, epoch: 1, generation: 1,
    authorityDigest: H, artifactDigest: H, policyDigest: H, pluginSetDigest: H, sourceDigest: source.digest,
    features: [feature], submissions: [submission], leases: [], dispatches: [],
    attempts: { 'implement:one:environment-blocker': { failures: 1, limit: 21, exhausted: false } },
    metadata: { commandIntent: { action: 'implement' }, workspace: { root: f.workspace } } };
  const project = { id: f.projectId, workspace: { root: f.workspace, excluded: [] } };
  const review = { kind: 'environment-blocker-review', actor: 'operator', projectId: f.projectId,
    runId: 'run', featureId: feature.id, expectedRevision: 3, sourceDigest: source.digest,
    submissionDigest: submission.submissionDigest, blockerDigest: digestJson(result.blocker), executables: [process.execPath] };
  return { ...f, state, project, review, currentSourceDigest: source.digest };
};

test('environment review binds fresh probe Evidence to the exact failed Submission without completing work or changing budgets', async () => {
  const f = await fixture();
  try {
    const before = structuredClone(f.state);
    const progress = [];
    const proof = await reviewDevelopmentEnvironment({ ...f, evidenceStore: f.harness.evidenceStore,
      patchReceiptDigest: H, onProgress: event => progress.push(event),
      probe: async ({ path, workspaceRoot }) => {
        assert.equal(workspaceRoot, f.workspace);
        return { path, arguments: ['--version'], executableSha256: H, exitCode: 0, stdout: 'tool 1.0\n' };
      } });
    assert.deepEqual(f.state, before);
    assert.deepEqual(progress.map(item => item.phase), ['started', 'passed']);
    const evidence = await f.harness.evidenceStore.read(proof.evidenceRef);
    const body = JSON.parse(evidence.bytes.toString('utf8'));
    assert.equal(proof.reviewDigest, digestJson(body));
    assert.equal(body.submissionDigest, f.review.submissionDigest);
    assert.equal(body.sourceDigest, f.state.sourceDigest);
    assert.equal(body.patchReceiptDigest, H);
    assert.equal(body.featureExecutionStarted, false);
    assert.equal(body.probes[0].exitCode, 0);
    assert.equal(environmentBlockedFeatures(f.state).length, 1);
  } finally { await f.cleanup(); }
});

test('review rejects stale identity, source, non-environment blockers, live transport, arbitrary probes and exhausted budgets', async () => {
  const f = await fixture();
  try {
    for (const mutate of [
      x => { x.review.runId = 'other'; },
      x => { x.review.expectedRevision++; },
      x => { x.review.submissionDigest = H; },
      x => { x.review.blockerDigest = H; },
      x => { x.currentSourceDigest = H; },
      x => { x.state.metadata.commandIntent.action = 'quality'; },
      x => { x.state.leases.push({ status: 'active' }); },
      x => { x.state.dispatches.push({ status: 'assigned' }); },
      x => { x.review.executables = [resolve(f.workspace, 'other.exe')]; },
      x => { x.review.executables = []; },
      x => { x.review.executables.push(process.execPath); },
      x => { x.review.arguments = ['--execute']; },
      x => { x.state.attempts['implement:one:environment-blocker'].exhausted = true; },
      x => { x.state.submissions[0].result.blocker.kind = 'approval'; },
      x => { x.state.submissions[0].evidenceRefs = []; },
      x => { x.state.projectId = 'other'; },
      x => { x.state.metadata.workspace.root = resolve(f.workspace, '..'); },
    ]) {
      const input = structuredClone({ state: f.state, project: f.project, review: f.review,
        currentSourceDigest: f.currentSourceDigest });
      mutate(input);
      assert.throws(() => assertEnvironmentReviewScope(input), error => error.code === 'DEVELOPMENT_ENVIRONMENT_REVIEW_INVALID');
    }
  } finally { await f.cleanup(); }
});

test('failed probes, absent observers, source changes and mismatched original Evidence cannot produce clearance', async () => {
  const f = await fixture();
  try {
    const input = { ...f, evidenceStore: f.harness.evidenceStore, patchReceiptDigest: H, onProgress: () => {} };
    await assert.rejects(() => reviewDevelopmentEnvironment({ ...input, onProgress: null }),
      error => error.code === 'DEVELOPMENT_ENVIRONMENT_REVIEW_INVALID');
    await assert.rejects(() => reviewDevelopmentEnvironment({ ...input, probe: async () => { throw Error('access denied'); } }), /access denied/);
    await assert.rejects(() => reviewDevelopmentEnvironment({ ...input,
      probe: async ({ path }) => ({ path, arguments: ['--version'], executableSha256: H, exitCode: 1, stdout: 'failed' }) }),
    error => error.code === 'DEVELOPMENT_ENVIRONMENT_REVIEW_INVALID');
    await assert.rejects(() => reviewDevelopmentEnvironment({ ...input,
      evidenceStore: { read: async () => ({ metadata: { projectId: 'other' }, bytes: Buffer.from('{"result":{}}') }) } }),
    error => error.code === 'DEVELOPMENT_ENVIRONMENT_REVIEW_INVALID');
    await assert.rejects(() => reviewDevelopmentEnvironment({ ...input, probe: async ({ path }) => {
      await writeFile(resolve(f.workspace, 'README.md'), 'changed during review');
      return { path, arguments: ['--version'], executableSha256: H, exitCode: 0, stdout: 'tool 1.0' };
    } }), error => error.code === 'DEVELOPMENT_ENVIRONMENT_REVIEW_INVALID');
    assert.equal(f.state.features[0].state, 'blocked');
    assert.equal(f.state.attempts['implement:one:environment-blocker'].failures, 1);
  } finally { await f.cleanup(); }
});
