import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digestJson } from '../src/common/canonical.mjs';
import { captureWorkspace } from '../src/common/workspace-snapshot.mjs';
import { prepareBudgetExtension } from '../src/kernel/attempt-budget.mjs';
import { writeDevelopmentSourceManifest } from '../src/application/development-source.mjs';
import { applyMigrationBudgetExtension, approvedBudgetExtensionProgress, approvedPostPatchBudgetProgress, verifyMigrationBudgetExtension } from '../src/application/development-budget-migration.mjs';
import { feature, makeFixture } from './test-support.mjs';

test('an H4 migration records its sealed original budget approval once before completion carry-over', async t => {
  const originalCwd = process.cwd();
  const fixture = await makeFixture(); t.after(fixture.cleanup);
  const configPath = resolve(fixture.workspace, 'harness.json');
  await writeFile(configPath, JSON.stringify({ schemaVersion: '1.0', kind: 'agent-harness-project',
    extensions: [
      { id: 'delivery-lifecycle-profile', version: '1.0.0', module: 'agent-harness/consumers/delivery-lifecycle' },
      { id: 'codex-runtime', version: '1.0.0', module: 'agent-harness/extensions/codex-runtime' }],
    project: { generatorExtensionId: 'delivery-lifecycle-profile', input: { gateRecipes: [] } },
    binding: { alias: fixture.projectId, projectId: fixture.projectId, profileId: 'delivery-lifecycle',
      extensionId: 'delivery-lifecycle-profile', workspaceRoot: '.' } }));
  const sourceDigest = (await captureWorkspace(fixture.workspace)).digest;
  const initial = { projectId: fixture.projectId, runId: 'original', status: 'all-remaining-blocked', epoch: 1, generation: 1,
    sourceDigest, profile: { id: 'feature-delivery', config: { requiredFinalGates: [], requiredDecisions: [] } },
    metadata: { commandIntent: { action: 'implement' }, workspace: { root: fixture.workspace }, lifecyclePlanDigest: 'a'.repeat(64) },
    features: [{ ...feature('A-02', { stage: 'implementation' }), logicalRoot: 'A-02', state: 'failed-budget' }],
    attempts: { 'A-02:implementation-incomplete': { key: 'A-02:implementation-incomplete', logicalRoot: 'A-02',
      limit: 21, failures: 21, exhausted: true, records: [] } },
    submissions: [{ submissionId: 'last', featureId: 'A-02', result: { status: 'blocked', failureClass: 'implementation-incomplete',
      blocker: { kind: 'in-scope-fix-blocked', summary: 'Approved work remains.' } } }],
    leases: [], dispatches: [], decisions: [], findings: [], events: [] };
  const { state } = await fixture.harness.authorityStore.create(initial, { commandId: 'seed', payload: {} });
  const proposal = prepareBudgetExtension({ state, featureId: 'A-02', attemptKey: 'A-02:implementation-incomplete',
    additional: 20, reason: 'The original user approved twenty more bounded continuations.', remainingWork: ['Finish the original certificates.'] });
  const approval = { id: 'original-user-approval', actor: 'human-user', decision: 'approved', action: 'extend-attempt-budget',
    projectId: state.projectId, runId: state.runId, featureId: 'A-02', proposalDigest: proposal.proposalDigest };
  const budgetExtension = { proposal, approval };
  const source = await writeDevelopmentSourceManifest({ bindingId: 'budget-migration', sourceRoot: originalCwd,
    controlRoot: originalCwd, dataRoot: fixture.dataRoot, configPath, projectRoot: fixture.workspace });
  const run = { projectId: state.projectId, runId: state.runId, revision: state.revision, activeLeaseIds: [], activeDispatchIds: [] };
  const body = { kind: 'development-patch-receipt', level: 'H4', migrationRunId: state.runId,
    manifestDigest: source.manifest.manifestDigest, afterRuntimeDigest: source.manifest.release.artifactDigest,
    budgetExtension, affectedRuns: [run] };
  const patchReceipt = { ...body, receiptDigest: digestJson(body) };
  try {
    process.chdir(fixture.workspace);
    assert.deepEqual(await verifyMigrationBudgetExtension({ manifest: source.manifest, runId: state.runId, budgetExtension }), budgetExtension);
    for (const change of [item => { item.approval.actor = 'agent'; }, item => { item.proposal.additional = 19; },
      item => { item.proposal.runId = 'other'; }]) {
      const invalid = structuredClone(budgetExtension); change(invalid);
      await assert.rejects(verifyMigrationBudgetExtension({ manifest: source.manifest, runId: state.runId, budgetExtension: invalid }));
    }
    assert.equal((await fixture.harness.authorityStore.read(state.projectId, state.runId)).authorityDigest, state.authorityDigest);
    assert.equal(approvedBudgetExtensionProgress(run, state, patchReceipt), false);
    await assert.rejects(applyMigrationBudgetExtension({ manifestFile: source.file,
      patchReceipt: { ...patchReceipt, receiptDigest: 'wrong' }, commandId: 'invalid-receipt' }),
    { code: 'DEVELOPMENT_BUDGET_MIGRATION_RECEIPT_MISMATCH' });
    const applied = await applyMigrationBudgetExtension({ manifestFile: source.file, patchReceipt, commandId: 'h4.budget' });
    assert.equal(applied.executionStarted, false); assert.equal(applied.used, 21); assert.equal(applied.afterLimit, 41);
    const after = await fixture.harness.authorityStore.read(state.projectId, state.runId);
    assert.equal(approvedBudgetExtensionProgress(run, after, patchReceipt), true);
    const idleAnchor = { ...run, authorityDigest: state.authorityDigest, sourceDigest: state.sourceDigest,
      epoch: state.epoch, generation: state.generation, eventSequence: state.events.at(-1)?.sequence ?? 0 };
    const h3Receipt = { level: 'H3' };
    assert.equal(approvedPostPatchBudgetProgress(idleAnchor, after, h3Receipt), true);
    assert.equal(approvedPostPatchBudgetProgress(idleAnchor, after, { level: 'H2' }), true);
    for (const change of [r => { r.authorityDigest = 'wrong'; }, r => { r.sourceDigest = 'wrong'; },
      r => { r.epoch += 1; }, r => { r.generation += 1; }, r => { r.eventSequence += 1; },
      r => { r.revision += 1; }, r => { r.activeLeaseIds.push('active'); }]) {
      const invalid = structuredClone(idleAnchor); change(invalid);
      assert.equal(approvedPostPatchBudgetProgress(invalid, after, h3Receipt), false);
    }
    for (const mutate of [s => { s.commands['h4.budget'].payloadDigest = 'wrong'; },
      s => { s.decisions[0].digest = 'wrong'; }, s => { s.metadata.attemptBudgetExtensions[0].approval.digest = 'wrong'; },
      s => { s.events.at(-1).additional = 21; }, s => { s.sourceDigest = 'changed'; },
      s => { s.dispatches.push({ status: 'assigned' }); }]) {
      const invalid = structuredClone(after); mutate(invalid);
      assert.equal(approvedPostPatchBudgetProgress(idleAnchor, invalid, h3Receipt), false);
    }
    assert.equal(approvedPostPatchBudgetProgress(idleAnchor, after, { level: 'H4' }), false);
    assert.equal(approvedPostPatchBudgetProgress(idleAnchor, after, patchReceipt), false);
    assert.deepEqual(after.submissions, state.submissions); assert.equal(after.dispatches.length, 0);
    assert.equal((await applyMigrationBudgetExtension({ manifestFile: source.file, patchReceipt, commandId: 'h4.budget' })).reused, true);
    for (const mutate of [s => { s.sourceDigest = 'drift'; }, s => { s.revision += 1; },
      s => { s.attempts[proposal.attemptKey].failures = 0; }, s => { s.features[0].state = 'pending'; },
      s => { s.metadata.attemptBudgetExtensions[0].approval.digest = 'wrong'; },
      s => { s.commands['h4.budget'].payloadDigest = 'wrong'; }, s => { s.events.at(-1).additional = 21; },
      s => { s.leases.push({ status: 'active' }); }]) {
      const changed = structuredClone(after); mutate(changed);
      assert.equal(approvedBudgetExtensionProgress(run, changed, patchReceipt), false);
    }
    assert.equal(approvedBudgetExtensionProgress({ ...run, revision: run.revision - 1 }, after, patchReceipt), false);
    assert.equal(approvedBudgetExtensionProgress(run, after, { ...patchReceipt, budgetExtension: null }), false);
  } finally { process.chdir(originalCwd); }
});
