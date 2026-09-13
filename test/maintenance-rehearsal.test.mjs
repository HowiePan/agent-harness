import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { createDefectBundle, projectDescriptorInput } from '../src/index.mjs';
import { command, dispatchAndBind, feature, makeFixture, recordResult, startRun } from './test-support.mjs';

const oldArtifact = 'a'.repeat(64);
const fixedArtifact = 'b'.repeat(64);

const descriptorDecision = id => ({ id, actor: 'project-owner', decision: 'approved', action: 'project-descriptor-update' });
const rebaseDecision = (fixture, state, id, artifactDigest) => ({
  id,
  actor: 'project-owner',
  decision: 'approved',
  action: 'artifact-rebase',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  context: {
    projectId: fixture.projectId,
    runId: 'maintenance-run',
    expectedRevision: state.revision + 1,
    previousArtifactDigest: state.artifactDigest,
    artifactDigest,
    impactedFeatureIds: ['affected'],
  },
});

test('consumer defect upgrade, original-run continuation, and failed-upgrade rollback stay receipt-bound', async t => {
  const fixture = await makeFixture({ releaseIdentity: { version: '1.0.0', artifactDigest: oldArtifact } });
  t.after(() => fixture.cleanup());
  const workspaceBefore = await readdir(fixture.workspace);
  const readmeBefore = await readFile(fixture.workspace + '/README.md', 'utf8');

  let descriptor = await fixture.harness.projectRegistry.get(fixture.projectId);
  descriptor = await fixture.harness.projectRegistry.register(
    { ...projectDescriptorInput(descriptor), harness: { version: '1.0.0', artifactDigest: oldArtifact } },
    { expectedRevision: descriptor.revision, commandId: 'bind-old-release', authorityDecision: descriptorDecision('bind-old-release') },
  );
  await startRun(fixture, { runId: 'maintenance-run', features: [feature('affected')], artifactDigest: oldArtifact });
  const bound = await dispatchAndBind(fixture, 'maintenance-run');
  const completed = await recordResult(fixture, 'maintenance-run', bound.dispatch);
  const attemptsBefore = structuredClone(completed.state.attempts);

  const bundle = createDefectBundle({
    protocolVersion: '1.0',
    harness: { version: '1.0.0', artifactDigest: oldArtifact, commit: 'baseline' },
    extensions: [],
    descriptorDigest: descriptor.descriptorDigest,
    command: { operation: 'recovery.capsule-create' },
    authorityRevision: completed.state.revision,
    dispatchIds: [bound.dispatch.dispatchId],
    evidenceRefs: completed.state.evidenceRefs,
    expected: { assessmentSource: 'immutable-staging' },
    actual: { assessmentSource: 'mutable-legacy-root' },
    reproduction: { fixture: 'synthetic-changing-source' },
    sanitization: { confirmed: true, removed: ['workspace path', 'runtime output'] },
  });
  assert.match(bundle.bundleDigest, /^[a-f0-9]{64}$/);

  descriptor = await fixture.harness.projectRegistry.register(
    { ...projectDescriptorInput(descriptor), harness: { version: '1.0.0', artifactDigest: fixedArtifact } },
    { expectedRevision: descriptor.revision, commandId: 'upgrade-fixed-release', authorityDecision: descriptorDecision('upgrade-fixed-release') },
  );
  let state = await fixture.harness.authorityStore.read(fixture.projectId, 'maintenance-run');
  const upgradeDecision = rebaseDecision(fixture, state, 'approve-fixed-release', fixedArtifact);
  state = (await fixture.harness.kernel.recordDecision(fixture.projectId, 'maintenance-run', upgradeDecision, command(state))).state;
  const upgraded = await fixture.harness.kernel.rebaseArtifact(
    fixture.projectId,
    'maintenance-run',
    { artifactDigest: fixedArtifact, impactedFeatureIds: ['affected'], decisionId: upgradeDecision.id },
    command(state),
  );
  assert.equal(upgraded.state.generation, 2);
  assert.deepEqual(upgraded.state.attempts, attemptsBefore);
  const resumed = await dispatchAndBind(fixture, 'maintenance-run');
  state = (await recordResult(fixture, 'maintenance-run', resumed.dispatch)).state;
  assert.equal(state.features[0].state, 'completed');

  descriptor = await fixture.harness.projectRegistry.register(
    { ...projectDescriptorInput(descriptor), harness: { version: '1.0.0', artifactDigest: oldArtifact } },
    { expectedRevision: descriptor.revision, commandId: 'rollback-failed-upgrade', authorityDecision: descriptorDecision('rollback-failed-upgrade') },
  );
  const rollbackDecision = rebaseDecision(fixture, state, 'approve-release-rollback', oldArtifact);
  state = (await fixture.harness.kernel.recordDecision(fixture.projectId, 'maintenance-run', rollbackDecision, command(state))).state;
  const rolledBack = await fixture.harness.kernel.rebaseArtifact(
    fixture.projectId,
    'maintenance-run',
    { artifactDigest: oldArtifact, impactedFeatureIds: ['affected'], decisionId: rollbackDecision.id },
    command(state),
  );
  assert.equal(rolledBack.state.generation, 3);
  assert.equal(rolledBack.state.artifactDigest, oldArtifact);
  assert.deepEqual(rolledBack.state.attempts, attemptsBefore);
  assert.equal(descriptor.commands['rollback-failed-upgrade'].authorityDecision.decision, 'approved');
  assert.equal(rolledBack.result.authorityDecisionId, rollbackDecision.id);
  assert.deepEqual(await readdir(fixture.workspace), workspaceBefore);
  assert.equal(await readFile(fixture.workspace + '/README.md', 'utf8'), readmeBefore);
});

test('artifact rebase rejects missing and context-mismatched decisions', async t => {
  const fixture = await makeFixture();
  t.after(() => fixture.cleanup());
  let state = await startRun(fixture, { runId: 'maintenance-run', features: [feature('affected')], artifactDigest: oldArtifact });
  await assert.rejects(
    () => fixture.harness.kernel.rebaseArtifact(fixture.projectId, 'maintenance-run', { artifactDigest: fixedArtifact, impactedFeatureIds: ['affected'] }, command(state)),
    error => error.code === 'ARTIFACT_REBASE_DECISION_REQUIRED',
  );
  const decision = { ...rebaseDecision(fixture, state, 'wrong-upgrade', fixedArtifact), context: { ...rebaseDecision(fixture, state, 'wrong-upgrade', fixedArtifact).context, artifactDigest: 'c'.repeat(64) } };
  state = (await fixture.harness.kernel.recordDecision(fixture.projectId, 'maintenance-run', decision, command(state))).state;
  await assert.rejects(
    () => fixture.harness.kernel.rebaseArtifact(fixture.projectId, 'maintenance-run', { artifactDigest: fixedArtifact, impactedFeatureIds: ['affected'], decisionId: decision.id }, command(state)),
    error => error.code === 'ARTIFACT_REBASE_DECISION_CONTEXT_MISMATCH',
  );
});
