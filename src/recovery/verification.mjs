import { readFileSync } from 'node:fs';
import { digestJson } from '../canonical.mjs';
import { assert } from '../errors.mjs';
import { assertJsonSchema } from '../json-schema.mjs';

const verificationSchema = JSON.parse(readFileSync(new URL('../../schemas/recovery-verification.schema.json', import.meta.url), 'utf8'));
export const recoveryVerificationMediaType = 'application/vnd.agent-harness.recovery-verification+json';

export const sealRecoveryVerification = body => {
  const receipt = { ...structuredClone(body), receiptDigest: digestJson(body) };
  assertJsonSchema(receipt, verificationSchema, { code: 'RECOVERY_VERIFICATION_SCHEMA_INVALID', label: 'Recovery verification Receipt' });
  return receipt;
};

export const assertRecoveryVerification = (receipt, { projectId, runId, state, now = () => new Date().toISOString() } = {}) => {
  assertJsonSchema(receipt, verificationSchema, { code: 'RECOVERY_VERIFICATION_SCHEMA_INVALID', label: 'Recovery verification Receipt' });
  const { receiptDigest, ...body } = receipt;
  assert(receiptDigest === digestJson(body), 'RECOVERY_VERIFICATION_DIGEST_MISMATCH', 'Recovery verification Receipt digest mismatch.');
  assert(Date.parse(receipt.expiresAt) > Date.parse(now()), 'RECOVERY_VERIFICATION_EXPIRED', 'Recovery verification Receipt has expired.');
  if (projectId) assert(receipt.projectId === projectId && receipt.runId === runId, 'RECOVERY_VERIFICATION_CONTEXT_MISMATCH', 'Recovery verification Receipt belongs to another run.');
  if (state) assert(receipt.authorityEpoch === state.epoch && receipt.authorityGeneration === state.generation && receipt.targetEpoch === state.epoch + 1, 'RECOVERY_VERIFICATION_CONTEXT_MISMATCH', 'Recovery verification Receipt does not match the current Authority epoch and generation.');
  return receipt;
};

export const readRecoveryVerification = async (evidenceStore, verificationRef, options = {}) => {
  assert(verificationRef, 'RECOVERY_VERIFICATION_REQUIRED', 'Live hard recovery requires a Recovery Capsule verification reference.');
  const record = await evidenceStore.read(verificationRef);
  assert(record.metadata.mediaType === recoveryVerificationMediaType && record.metadata.labels?.includes('recovery-capsule-verification'), 'RECOVERY_VERIFICATION_EVIDENCE_INVALID', 'Recovery verification reference is not a verification Receipt.');
  let receipt;
  try { receipt = JSON.parse(record.bytes.toString('utf8')); }
  catch { assert(false, 'RECOVERY_VERIFICATION_EVIDENCE_INVALID', 'Recovery verification Receipt is not valid JSON.'); }
  const verified = assertRecoveryVerification(receipt, options);
  assert(record.metadata.projectId === verified.projectId && record.metadata.runId === verified.runId && record.metadata.epoch === verified.authorityEpoch && record.metadata.generation === verified.authorityGeneration, 'RECOVERY_VERIFICATION_EVIDENCE_CONTEXT_MISMATCH', 'Recovery verification Evidence metadata does not match its Receipt.');
  return { ...verified, verificationRef };
};
