import { digestJson, withoutKeys } from '../canonical.mjs';
import { assert } from '../errors.mjs';

const digestPattern = /^[a-f0-9]{64}$/;
const versionPattern = /^\d+\.\d+\.\d+$/;
const sensitiveKey = /(?:authorization|cookie|credential|password|private.?key|prompt|secret|token)/i;

const collectSensitiveKeys = (value, path = '$', output = []) => {
  if (Array.isArray(value)) value.forEach((item, index) => collectSensitiveKeys(item, `${path}[${index}]`, output));
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if (sensitiveKey.test(key)) output.push(`${path}.${key}`);
    collectSensitiveKeys(child, `${path}.${key}`, output);
  }
  return output;
};

export const createDefectBundle = input => {
  assert(input?.protocolVersion === '1.0', 'DEFECT_PROTOCOL_INVALID', 'Defect Bundle protocolVersion must be 1.0.');
  assert(versionPattern.test(input.harness?.version ?? '') && digestPattern.test(input.harness?.artifactDigest ?? ''), 'DEFECT_HARNESS_IDENTITY_INVALID', 'Defect Bundle requires an exact Harness version and artifact digest.');
  assert(Array.isArray(input.extensions), 'DEFECT_EXTENSIONS_REQUIRED', 'Defect Bundle requires Extension identities.');
  for (const extension of input.extensions) assert(extension?.id && versionPattern.test(extension.version ?? ''), 'DEFECT_EXTENSION_IDENTITY_INVALID', 'Defect Bundle contains an invalid Extension identity.');
  assert(digestPattern.test(input.descriptorDigest ?? ''), 'DEFECT_DESCRIPTOR_DIGEST_INVALID', 'Defect Bundle requires a sanitized Project Descriptor digest.');
  assert(input.command && Number.isInteger(input.authorityRevision) && input.authorityRevision >= 0, 'DEFECT_COMMAND_CONTEXT_INVALID', 'Defect Bundle requires command and Authority revision context.');
  assert(Object.hasOwn(input, 'expected') && Object.hasOwn(input, 'actual') && input.reproduction, 'DEFECT_REPRODUCTION_REQUIRED', 'Defect Bundle requires expected, actual, and reproduction values.');
  assert(input.sanitization?.confirmed === true, 'DEFECT_SANITIZATION_REQUIRED', 'Defect Bundle sanitization must be explicitly confirmed.');
  const sensitive = collectSensitiveKeys(input);
  assert(sensitive.length === 0, 'DEFECT_SENSITIVE_FIELD_REJECTED', 'Defect Bundle contains sensitive field names.', { sensitive });
  const body = structuredClone(withoutKeys(input, ['bundleDigest']));
  return { ...body, bundleDigest: digestJson(body) };
};

export const verifyDefectBundle = input => {
  const bundle = createDefectBundle(input);
  assert(input.bundleDigest === bundle.bundleDigest, 'DEFECT_BUNDLE_DIGEST_MISMATCH', 'Defect Bundle digest mismatch.');
  return bundle;
};

