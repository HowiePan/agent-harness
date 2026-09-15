import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { recordLegacySourceUnavailable, verifyLegacySourceDisposition } from '../src/index.mjs';
import { digestJson, withoutKeys } from '../src/canonical.mjs';
import { makeFixture } from './test-support.mjs';

const importer = { id: 'legacy-probe', version: '1.0.0' };

test('missing legacy source can only be sealed as clean-start-only disposition', async t => {
  const fixture = await makeFixture();
  t.after(() => fixture.cleanup());
  const legacyRoot = resolve(fixture.root, 'removed-legacy-root');
  const commandContext = { expectedRevision: 0, commandId: 'record-source-loss' };
  const output = await recordLegacySourceUnavailable({ projectId: fixture.projectId, legacyRoot, importer, ...commandContext, dataRoot: fixture.dataRoot, controlRoot: fixture.harness.controlRoot, now: () => '2026-09-13T00:00:00.000Z' });
  assert.match(output.ref, /^migration-receipt:[a-f0-9]{64}$/);
  assert.equal(output.receipt.consequences.liveHardRecovery, 'forbidden');
  assert.equal(output.receipt.consequences.allowedNextStep, 'new-run-clean-start');
  assert.equal(output.receipt.authorityBasis, 'verified-source-observation');
  assert.equal('decision' in output.receipt, false);
  assert.deepEqual(verifyLegacySourceDisposition(output.receipt), output.receipt);
  const repeated = await recordLegacySourceUnavailable({ projectId: fixture.projectId, legacyRoot, importer, ...commandContext, dataRoot: fixture.dataRoot, controlRoot: fixture.harness.controlRoot, now: () => '2027-01-01T00:00:00.000Z' });
  assert.equal(repeated.reused, true);
  assert.deepEqual(repeated.receipt, output.receipt);
  await assert.rejects(
    () => recordLegacySourceUnavailable({ projectId: fixture.projectId, legacyRoot, importer: { ...importer, version: '1.0.1' }, ...commandContext, dataRoot: fixture.dataRoot, controlRoot: fixture.harness.controlRoot }),
    error => error.code === 'COMMAND_ID_REUSED',
  );
  const persisted = JSON.parse(await readFile(resolve(fixture.dataRoot, 'migration', 'legacy-source', output.receipt.receiptDigest + '.json'), 'utf8'));
  assert.deepEqual(persisted, output.receipt);
});

test('source disposition rejects existing roots and mismatched legacy acknowledgements', async t => {
  const fixture = await makeFixture();
  t.after(() => fixture.cleanup());
  const legacyRoot = resolve(fixture.root, 'existing-legacy-root');
  await mkdir(legacyRoot);
  const decision = { id: 'ack-source-loss', actor: 'project-owner', decision: 'acknowledged', action: 'legacy-source-unavailable-clean-start', context: { projectId: fixture.projectId, legacyRoot, importerId: importer.id } };
  await assert.rejects(() => recordLegacySourceUnavailable({ projectId: fixture.projectId, legacyRoot, importer, decision, expectedRevision: 0, commandId: 'existing-root', dataRoot: fixture.dataRoot, controlRoot: fixture.harness.controlRoot }), error => error.code === 'LEGACY_SOURCE_STILL_AVAILABLE');
  await assert.rejects(() => recordLegacySourceUnavailable({ projectId: fixture.projectId, legacyRoot: resolve(fixture.root, 'absent'), importer, decision, expectedRevision: 0, commandId: 'mismatch', dataRoot: fixture.dataRoot, controlRoot: fixture.harness.controlRoot }), error => error.code === 'LEGACY_SOURCE_DISPOSITION_DECISION_MISMATCH');
  const absentRoot = resolve(fixture.root, 'legacy-compatible-absent');
  const legacy = (await recordLegacySourceUnavailable({ projectId: fixture.projectId, legacyRoot: absentRoot, importer, decision: { ...decision, context: { projectId: fixture.projectId, legacyRoot: absentRoot, importerId: importer.id } }, expectedRevision: 0, commandId: 'legacy-compatible', dataRoot: fixture.dataRoot, controlRoot: fixture.harness.controlRoot })).receipt;
  delete legacy.authorityBasis;
  legacy.receiptDigest = digestJson(withoutKeys(legacy, ['receiptDigest']));
  assert.deepEqual(verifyLegacySourceDisposition(legacy), legacy);
});
