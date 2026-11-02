import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cargoTestInputCandidate } from '../src/platform/workflow/gates/cargo-input-binding.mjs';
import { resolveVerificationInputs, bindContinuationVerificationInputs, assertVerificationBindingStable } from '../src/application/verification-input-bindings.mjs';
import { executeDeliveryCheck } from '../src/application/delivery-verification.mjs';
import { makeFixture } from './test-support.mjs';

const content = '[[test]]\nname = "suite"\npath = "tests/suites/suite.rs"\n';
const check = () => ({ id: 'behavior', command: [process.execPath, 'verify.mjs', '--test', 'suite'],
  inputs: ['engine/Cargo.toml', 'engine/tests/suite.rs', 'verify.mjs'], outputs: [],
  covers: ['behavior'], executionClass: 'deterministic-process', cacheable: true, toolchainFiles: [process.execPath] });
const candidate = text => cargoTestInputCandidate({ manifestPath: 'engine/Cargo.toml', content: text,
  command: check().command, declaredPath: 'engine/tests/suite.rs' });
const fixture = async t => {
  const f = await makeFixture(); t.after(f.cleanup);
  await mkdir(resolve(f.workspace, 'engine/tests/suites'), { recursive: true });
  await writeFile(resolve(f.workspace, 'engine/Cargo.toml'), content);
  await writeFile(resolve(f.workspace, 'engine/tests/suites/suite.rs'), 'behavior source');
  await writeFile(resolve(f.workspace, 'verify.mjs'), "import { readFileSync } from 'node:fs'; import assert from 'node:assert/strict'; assert.equal(readFileSync('engine/tests/suites/suite.rs','utf8'),'behavior source');");
  return f;
};
const resolution = f => ({ check: check(), workspaceRoot: f.workspace, allowedPaths: ['engine', 'verify.mjs'] });

test('manifest binding accepts one explicit named target and rejects ambiguous, escaped and unsupported declarations', () => {
  assert.equal(candidate(content).resolvedPath, 'engine/tests/suites/suite.rs');
  for (const invalid of [content + content, content.replace('tests/suites/', '../'),
    content.replace('suite.rs', 'other.rs'), content.replace('"suite"', '"""suite"""'),
    content + '"path" = "elsewhere/suite.rs"\n', content.replace('path =', 'path.extra =')]) {
    assert.equal(candidate(invalid), null, invalid);
  }
  assert.equal(cargoTestInputCandidate({ manifestPath: 'engine/Cargo.toml', content,
    command: ['cargo', '--test', 'suite', '--test', 'other'], declaredPath: 'engine/tests/suite.rs' }), null);
});

test('binding preserves approved command and contract, seals effective inputs and rejects post-dispatch target drift', async t => {
  const f = await fixture(t); const original = check();
  const bound = await resolveVerificationInputs(resolution(f));
  assert.deepEqual(bound.missingInputs, []);
  assert.equal(bound.bindings.length, 1);
  assert.deepEqual(bound.effectiveCheck, { ...original, inputs: ['engine/Cargo.toml', 'engine/tests/suites/suite.rs', 'verify.mjs'] });
  assert.deepEqual(original, check());
  const context = await bindContinuationVerificationInputs({ continuation: { workBatch: { checks: [original] }, instructions: [] },
    feature: { allowedPaths: ['engine', 'verify.mjs'] }, workspaceRoot: f.workspace });
  assert.deepEqual(context.workBatch.approvedChecks, [original]);
  assert.deepEqual(context.workBatch.checks, [bound.effectiveCheck]);
  assertVerificationBindingStable(context.workBatch.verificationInputBindings[0], bound);
  await writeFile(resolve(f.workspace, 'engine/tests/suite.rs'), 'new competing source');
  assert.throws(() => assertVerificationBindingStable(bound, { ...bound, bindings: [] }), { code: 'DELIVERY_INPUT_BINDING_DRIFT' });
  assert.throws(() => assertVerificationBindingStable(bound, { ...bound, approvedCheckDigest: 'changed' }), { code: 'DELIVERY_INPUT_BINDING_DRIFT' });
});

test('binding cannot guess without declared anchor or cross denied and read scopes', async t => {
  const f = await fixture(t);
  for (const overrides of [{ allowedPaths: [] }, { forbiddenPaths: ['engine/tests/suites'] },
    { excluded: ['engine/tests/suites'] }, { check: { ...check(), inputs: ['engine/tests/suite.rs', 'verify.mjs'] } }]) {
    const value = await resolveVerificationInputs({ ...resolution(f), ...overrides });
    assert.deepEqual(value.bindings, []); assert.deepEqual(value.missingInputs, ['engine/tests/suite.rs']);
  }
  await assert.rejects(resolveVerificationInputs({ ...resolution(f), check: { ...check(), inputs: ['../outside'] } }),
    { code: 'DELIVERY_INPUT_PATH_INVALID' });
});

test('Host fingerprints resolved sources and manifest proof, reuses genuine evidence, and never executes missing inputs', async t => {
  const f = await fixture(t);
  const args = { ...resolution(f), inputScope: { allowedPaths: ['engine', 'verify.mjs'] }, dataRoot: f.dataRoot,
    controlRoot: f.harness.controlRoot, evidenceStore: f.harness.evidenceStore,
    sourceContext: { projectId: f.projectId, runId: 'fixture', epoch: 1, generation: 1 } };
  const first = await executeDeliveryCheck(args);
  assert.equal(first.status, 'passed'); assert.equal(first.cacheHit, false);
  assert.deepEqual(first.approvedCheck, check()); assert.equal(first.inputBinding.bindings.length, 1);
  assert.equal((await executeDeliveryCheck(args)).cacheHit, true);
  await writeFile(resolve(f.workspace, 'engine/Cargo.toml'), content + '# changed proof anchor\n');
  const changed = await executeDeliveryCheck(args); assert.equal(changed.cacheHit, false); assert.equal(changed.status, 'passed');
  await writeFile(resolve(f.workspace, 'engine/tests/suites/suite.rs'), 'broken behavior');
  assert.equal((await executeDeliveryCheck(args)).status, 'failed');
  await unlink(resolve(f.workspace, 'engine/tests/suites/suite.rs'));
  await writeFile(resolve(f.workspace, 'verify.mjs'), 'throw new Error("MUST_NOT_RUN");');
  const missing = await executeDeliveryCheck(args);
  assert.equal(missing.status, 'environment-failed'); assert.equal(missing.cacheHit, false);
  assert.equal(missing.executorReceipt.payload.environmentError.code, 'DELIVERY_VERIFICATION_INPUT_MISSING');
  assert.doesNotMatch(missing.executorReceipt.payload.stderr, /MUST_NOT_RUN/);
  const drift = await executeDeliveryCheck({ ...args, pinnedInputBinding: first.inputBinding });
  assert.equal(drift.status, 'environment-failed');
  assert.equal(drift.executorReceipt.payload.environmentError.code, 'DELIVERY_INPUT_BINDING_DRIFT');
  assert.doesNotMatch(drift.executorReceipt.payload.stderr, /MUST_NOT_RUN/);
});
