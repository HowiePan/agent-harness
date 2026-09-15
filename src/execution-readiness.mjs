import { readFileSync } from 'node:fs';
import { digestJson, withoutKeys } from './canonical.mjs';
import { assert } from './errors.mjs';
import { assertJsonSchema } from './json-schema.mjs';
import { validateRunLineageResolution } from './lineage.mjs';

const schema = JSON.parse(readFileSync(new URL('../schemas/execution-readiness-report.schema.json', import.meta.url), 'utf8'));
const lineageSchema = JSON.parse(readFileSync(new URL('../schemas/run-lineage-resolution.schema.json', import.meta.url), 'utf8'));
const schemas = new Map([['run-lineage-resolution.schema.json', lineageSchema]]);

export const executionReadinessDigest = report => digestJson(withoutKeys(report, ['reportDigest']));

export const sealExecutionReadinessReport = input => {
  const body = structuredClone(withoutKeys(input, ['reportDigest']));
  const report = { ...body, reportDigest: executionReadinessDigest(body) };
  assertJsonSchema(report, schema, { schemas, code: 'EXECUTION_READINESS_REPORT_INVALID', label: 'Execution Readiness Report' });
  return report;
};

export const verifyExecutionReadinessReport = (input, { plan, now = () => new Date().toISOString(), requireReady = true } = {}) => {
  assertJsonSchema(input, schema, { schemas, code: 'EXECUTION_READINESS_REPORT_INVALID', label: 'Execution Readiness Report' });
  assert(input.reportDigest === executionReadinessDigest(input), 'EXECUTION_READINESS_REPORT_DIGEST_MISMATCH', 'Execution Readiness Report digest does not match its contents.');
  if (plan) {
    assert(input.planDigest === plan.planDigest, 'EXECUTION_READINESS_PLAN_MISMATCH', 'Execution Readiness Report belongs to another Lifecycle Plan.');
    assert(input.project.id === plan.project.id && input.project.revision === plan.project.revision && input.project.descriptorDigest === plan.project.descriptorDigest, 'EXECUTION_READINESS_PROJECT_MISMATCH', 'Execution Readiness Report belongs to another Project Descriptor revision.');
    assert(input.release.version === plan.harness.version && input.release.artifactDigest === plan.harness.artifactDigest, 'EXECUTION_READINESS_RELEASE_MISMATCH', 'Execution Readiness Report belongs to another Harness release.');
    const lineage = validateRunLineageResolution(input.lineageResolution);
    assert(lineage.planDigest === plan.planDigest && lineage.logicalTaskKey === plan.logicalTaskKey, 'EXECUTION_READINESS_LINEAGE_MISMATCH', 'Execution Readiness Report contains a lineage resolution for another Lifecycle Plan.');
  }
  assert(Date.parse(input.expiresAt) > Date.parse(typeof now === 'function' ? now() : now), 'EXECUTION_READINESS_EXPIRED', 'Execution Readiness Report has expired.');
  if (requireReady) assert(input.executionReady === true, 'EXECUTION_NOT_READY', 'Lifecycle execution readiness contains blockers.', { issues: input.checks.flatMap(check => check.issues) });
  return structuredClone(input);
};
