import { readFileSync } from 'node:fs';
import { lstat, mkdir } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { digestJson, withoutKeys } from '../canonical.mjs';
import { assert } from '../errors.mjs';
import { atomicWriteJson, readJson, withDirectoryLock } from '../kernel/atomic-io.mjs';
import { assertJsonSchema } from '../json-schema.mjs';
import { safeSegment } from '../paths.mjs';
import { assertHarnessWritePath } from '../write-boundary.mjs';

const schema = JSON.parse(readFileSync(new URL('../../schemas/legacy-source-disposition.schema.json', import.meta.url), 'utf8'));

const assertAbsent = async path => {
  try {
    await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  assert(false, 'LEGACY_SOURCE_STILL_AVAILABLE', 'An unavailable-source disposition cannot be issued while the legacy root exists.', { legacyRoot: path });
};

export const verifyLegacySourceDisposition = input => {
  assertJsonSchema(input, schema, { code: 'LEGACY_SOURCE_DISPOSITION_SCHEMA_INVALID', label: 'Legacy Source Disposition Receipt' });
  assert(input.receiptDigest === digestJson(withoutKeys(input, ['receiptDigest'])), 'LEGACY_SOURCE_DISPOSITION_DIGEST_MISMATCH', 'Legacy Source Disposition Receipt digest mismatch.');
  return structuredClone(input);
};

export const recordLegacySourceUnavailable = async ({ projectId, legacyRoot, importer, decision, expectedRevision, commandId, dataRoot, controlRoot, now = () => new Date().toISOString() }) => {
  assert(projectId && isAbsolute(legacyRoot) && importer?.id && importer?.version, 'LEGACY_SOURCE_DISPOSITION_CONTEXT_INVALID', 'Legacy source disposition requires a project, absolute legacy root, and exact importer identity.');
  assert(commandId, 'COMMAND_ID_REQUIRED', 'Legacy source disposition requires a stable command ID.');
  assert(expectedRevision === 0, 'EXPECTED_REVISION_REQUIRED', 'Legacy source disposition is append-only and requires expected revision 0.');
  assert(decision?.id && decision.actor && decision.decision === 'acknowledged' && decision.action === 'legacy-source-unavailable-clean-start', 'LEGACY_SOURCE_DISPOSITION_DECISION_REQUIRED', 'Legacy source loss requires an explicit clean-start acknowledgement.');
  assert(decision.context?.projectId === projectId && decision.context?.legacyRoot === legacyRoot && decision.context?.importerId === importer.id, 'LEGACY_SOURCE_DISPOSITION_DECISION_MISMATCH', 'Legacy source disposition decision does not match the project, root, and importer.');
  await assertAbsent(legacyRoot);
  const directory = assertHarnessWritePath(resolve(dataRoot, 'migration', 'legacy-source'), 'legacy source disposition directory', controlRoot);
  const requestDigest = digestJson({ projectId, legacyRoot, importer: { id: importer.id, version: importer.version }, decision });
  const commandFile = resolve(directory, 'commands', safeSegment(commandId, 'commandId') + '.json');
  await mkdir(directory, { recursive: true });
  return withDirectoryLock(commandFile + '.lock', async () => {
    const prior = await readJson(commandFile, null);
    if (prior) {
      assert(prior.requestDigest === requestDigest, 'COMMAND_ID_REUSED', 'Legacy source disposition command ID was reused with another request.');
      const existing = await readJson(resolve(directory, prior.receiptDigest + '.json'));
      verifyLegacySourceDisposition(existing);
      return { receipt: existing, ref: 'migration-receipt:' + existing.receiptDigest, reused: true };
    }
    const body = {
      protocolVersion: '1.0',
      kind: 'legacy-source-unavailable',
      commandId,
      expectedRevision,
      requestDigest,
      projectId,
      legacyRoot,
      importer: { id: importer.id, version: importer.version },
      observation: 'absent',
      decision: structuredClone(decision),
      consequences: { recoveryCapsule: 'unavailable', liveHardRecovery: 'forbidden', legacyAuthorityImport: 'forbidden', allowedNextStep: 'new-run-clean-start' },
      observedAt: now(),
    };
    const receipt = { ...body, receiptDigest: digestJson(body) };
    verifyLegacySourceDisposition(receipt);
    await atomicWriteJson(resolve(directory, receipt.receiptDigest + '.json'), receipt, { root: dataRoot });
    await atomicWriteJson(commandFile, { commandId, requestDigest, receiptDigest: receipt.receiptDigest }, { root: dataRoot });
    return { receipt, ref: 'migration-receipt:' + receipt.receiptDigest, reused: false };
  }, { root: dataRoot });
};
