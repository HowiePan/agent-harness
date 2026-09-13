import { readFileSync } from 'node:fs';
import { digestJson, withoutKeys } from '../canonical.mjs';
import { assert } from '../errors.mjs';
import { assertJsonSchema } from '../json-schema.mjs';

const schema = JSON.parse(readFileSync(new URL('../../schemas/release-candidate-receipt.schema.json', import.meta.url), 'utf8'));

export const sealReleaseCandidateReceipt = input => {
  const body = structuredClone(withoutKeys(input, ['receiptDigest']));
  const receipt = { ...body, receiptDigest: digestJson(body) };
  assertJsonSchema(receipt, schema, { code: 'RELEASE_RECEIPT_SCHEMA_INVALID', label: 'Release Candidate Receipt' });
  return receipt;
};

export const verifyReleaseCandidateReceipt = input => {
  assertJsonSchema(input, schema, { code: 'RELEASE_RECEIPT_SCHEMA_INVALID', label: 'Release Candidate Receipt' });
  assert(input.receiptDigest === digestJson(withoutKeys(input, ['receiptDigest'])), 'RELEASE_RECEIPT_DIGEST_MISMATCH', 'Release Candidate Receipt digest mismatch.');
  return structuredClone(input);
};
