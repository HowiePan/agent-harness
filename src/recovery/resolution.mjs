import { readFileSync } from 'node:fs';
import { digestJson, withoutKeys } from '../canonical.mjs';
import { assert } from '../errors.mjs';
import { assertJsonSchema } from '../json-schema.mjs';

const schema = JSON.parse(readFileSync(new URL('../../schemas/recovery-resolution.schema.json', import.meta.url), 'utf8'));
export const recoveryResolutionMediaType = 'application/vnd.agent-harness.recovery-resolution+json';
export const recoveryResolutionDigest = receipt => digestJson(withoutKeys(receipt, ['receiptDigest']));

export const sealRecoveryResolution = input => {
  const body = structuredClone(withoutKeys(input, ['receiptDigest']));
  const receipt = { ...body, receiptDigest: recoveryResolutionDigest(body) };
  assertJsonSchema(receipt, schema, { code: 'RECOVERY_RESOLUTION_INVALID', label: 'Recovery Resolution Receipt' });
  return receipt;
};

export const assertRecoveryResolution = (receipt, { projectId, runId, state, verification, now = () => new Date().toISOString() } = {}) => {
  assertJsonSchema(receipt, schema, { code: 'RECOVERY_RESOLUTION_INVALID', label: 'Recovery Resolution Receipt' });
  assert(receipt.receiptDigest === recoveryResolutionDigest(receipt), 'RECOVERY_RESOLUTION_DIGEST_MISMATCH', 'Recovery Resolution Receipt digest mismatch.');
  assert(Date.parse(receipt.expiresAt) > Date.parse(typeof now === 'function' ? now() : now), 'RECOVERY_RESOLUTION_EXPIRED', 'Recovery Resolution Receipt has expired.');
  assert(receipt.action === 'hard-recovery', 'RECOVERY_RESOLUTION_ACTION_MISMATCH', 'Recovery Resolution does not select hard recovery.');
  assert(receipt.effectClasses.length === 4 && ['authority-epoch-transition', 'transport-invalidation', 'completion-revalidation', 'rollback-snapshot'].every(effect => receipt.effectClasses.includes(effect)), 'RECOVERY_RESOLUTION_EFFECTS_INVALID', 'Hard recovery must preserve every mandatory safe effect.');
  if (projectId) assert(receipt.projectId === projectId && receipt.runId === runId, 'RECOVERY_RESOLUTION_CONTEXT_MISMATCH', 'Recovery Resolution belongs to another Run.');
  if (state) assert(receipt.authorityEpoch === state.epoch && receipt.authorityGeneration === state.generation && receipt.expectedRevision === state.revision && receipt.targetEpoch === state.epoch + 1, 'RECOVERY_RESOLUTION_CONTEXT_MISMATCH', 'Recovery Resolution does not match current Authority.');
  if (verification) assert(receipt.verificationRef === verification.verificationRef && receipt.targetEpoch === verification.targetEpoch, 'RECOVERY_RESOLUTION_VERIFICATION_MISMATCH', 'Recovery Resolution does not match the verified Capsule.');
  return structuredClone(receipt);
};

export const readRecoveryResolution = async (evidenceStore, resolutionRef, options = {}) => {
  assert(resolutionRef, 'RECOVERY_RESOLUTION_REQUIRED', 'Hard recovery requires a policy-generated Recovery Resolution Receipt.');
  const record = await evidenceStore.read(resolutionRef);
  assert(record.metadata.mediaType === recoveryResolutionMediaType && record.metadata.labels?.includes('recovery-resolution'), 'RECOVERY_RESOLUTION_EVIDENCE_INVALID', 'Recovery resolution reference is not a Recovery Resolution Receipt.');
  let receipt;
  try { receipt = JSON.parse(record.bytes.toString('utf8')); }
  catch { assert(false, 'RECOVERY_RESOLUTION_EVIDENCE_INVALID', 'Recovery Resolution Receipt is not valid JSON.'); }
  const resolved = assertRecoveryResolution(receipt, options);
  assert(record.metadata.projectId === resolved.projectId && record.metadata.runId === resolved.runId && record.metadata.epoch === resolved.authorityEpoch && record.metadata.generation === resolved.authorityGeneration, 'RECOVERY_RESOLUTION_EVIDENCE_CONTEXT_MISMATCH', 'Recovery Resolution Evidence metadata does not match its Receipt.');
  return { ...resolved, resolutionRef };
};
