import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile as execFileCallback } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { captureWorkspace } from '../src/common/workspace-snapshot.mjs';
import { loadReleaseIdentity } from '../src/application/release-identity.mjs';
import { projectDescriptorInput } from '../src/platform/registry/project-contract.mjs';
import { feature, makeFixture } from './test-support.mjs';

const execFile = promisify(execFileCallback);

test('CLI previews without writes, applies one approved bounded addition, and never dispatches', async t => {
  const controlRoot = resolve(process.cwd());
  const releaseIdentity = await loadReleaseIdentity();
  const fixture = await makeFixture({ releaseIdentity }); t.after(fixture.cleanup);
  const current = await fixture.harness.projectRegistry.get(fixture.projectId);
  await fixture.harness.projectRegistry.register({ ...projectDescriptorInput(current), harness: {
    version: releaseIdentity.version, artifactDigest: releaseIdentity.artifactDigest } },
  { expectedRevision: current.revision, commandId: 'pin-cli-project', authorityDecision: { actor: 'test-user', decision: 'approved' } });
  const sourceDigest = (await captureWorkspace(fixture.workspace)).digest;
  const root = 'implementation:A-02';
  const key = `${root}:implementation-incomplete`;
  const initial = { projectId: fixture.projectId, runId: 'budget-cli', protocolVersion: '1.0',
    status: 'all-remaining-blocked', epoch: 1, generation: 1, sourceDigest,
    profile: { id: 'feature-delivery', config: { requiredFinalGates: [], requiredDecisions: [] } },
    metadata: { commandIntent: { action: 'implement' }, workspace: { root: fixture.workspace }, lifecyclePlanDigest: 'a'.repeat(64) },
    features: [{ ...feature('A-02', { stage: 'implementation', implementationProgressRetries: 20 }), logicalRoot: root, state: 'failed-budget' }],
    attempts: { [key]: { key, logicalRoot: root, failures: 21, limit: 21, exhausted: true, records: [] } },
    submissions: [{ submissionId: 'submission-one', featureId: 'A-02', result: { status: 'blocked', failureClass: 'implementation-incomplete',
      blocker: { kind: 'in-scope-fix-blocked', summary: 'Unchanged work remains.' } } }],
    dispatches: [], leases: [], findings: [], decisions: [], events: [] };
  const { state } = await fixture.harness.authorityStore.create(initial, { commandId: 'budget-cli-seed', payload: {} });
  const requestFile = resolve(fixture.root, 'budget-request.json');
  await writeFile(requestFile, JSON.stringify({ featureId: 'A-02', attemptKey: key, additional: 20,
    reason: 'Verified progress needs additional bounded work.', remainingWork: ['Finish certificates.'] }));
  const cli = (...args) => execFile(process.execPath, [resolve(controlRoot, 'bin/agent-harness.mjs'), 'run', ...args,
    '--control-root', controlRoot, '--data-root', fixture.dataRoot, '--project', fixture.projectId, '--run', 'budget-cli'],
  { cwd: fixture.workspace, windowsHide: true });
  const before = (await captureWorkspace(fixture.dataRoot)).digest;
  const preview = JSON.parse((await cli('budget-plan', '--request', requestFile)).stdout);
  assert.equal(preview.executionStarted, false); assert.equal(preview.proposal.afterLimit, 41);
  assert.equal((await captureWorkspace(fixture.dataRoot)).digest, before);
  const proposalFile = resolve(fixture.root, 'proposal.json');
  const approvalFile = resolve(fixture.root, 'approval.json');
  await writeFile(proposalFile, JSON.stringify(preview.proposal));
  await writeFile(approvalFile, JSON.stringify({ id: 'human-budget-cli', actor: 'human-user', decision: 'approved', action: 'extend-attempt-budget',
    projectId: fixture.projectId, runId: 'budget-cli', featureId: 'A-02', proposalDigest: preview.proposal.proposalDigest }));
  const invoke = () => cli('budget-extend', '--proposal', proposalFile, '--approval', approvalFile,
    '--expected-revision', String(state.revision), '--command-id', 'apply-budget-cli');
  const applied = JSON.parse((await invoke()).stdout);
  assert.equal(applied.executionStarted, false); assert.equal(applied.continuation, 'await-explicit-implement');
  const after = await fixture.harness.authorityStore.read(fixture.projectId, 'budget-cli');
  assert.equal(after.attempts[key].failures, 21); assert.equal(after.attempts[key].limit, 41);
  assert.equal(after.features[0].state, 'blocked'); assert.deepEqual(after.dispatches, []); assert.deepEqual(after.leases, []);
  assert.equal(JSON.parse((await invoke()).stdout).revision, after.revision);
  const next = JSON.parse((await cli('budget-plan', '--request', requestFile)).stdout);
  assert.notEqual(next.proposal.proposalDigest, preview.proposal.proposalDigest);
  assert.equal(next.proposal.beforeLimit, 41);
});
