import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateDeliveryBatches } from '../src/flows/delivery-lifecycle/delivery-batches.mjs';
import { executeDeliveryCheck } from '../src/application/delivery-verification.mjs';
import { buildImplementationContinuation } from '../src/application/implementation-continuation.mjs';
import { makeFixture } from './test-support.mjs';
import { proposal, compile, makeCheck, receiverId, finalId, completion } from './delivery-batch-support.mjs';

test('planned moderate deliveries compile to distinct native Features with shared ancestry and original final acceptance', () => {
  const p = proposal(); const features = compile(p);
  assert.equal(features.length, 2);
  assert.deepEqual(features.map(item => item.id), ['implement/V1/F01/delivery/receiver', 'implement/V1/F01']);
  assert.equal(new Set(features.map(item => item.logicalRoot)).size, 1);
  assert.deepEqual(features[1].dependsOn, [features[0].id]);
  assert.deepEqual(features[1].metadata.approvedProposal.contracts, p.contracts);
  assert.match(features[0].task.instructions.join(' '), /completed planned batch|completed batch is a valid planned handoff/i);
});

for (const [name, mutate, code] of [
  ['Feature oversized including repair reserve', p => p.deliveryBatchReserve = 19, 'DELIVERY_BATCH_CAPACITY'],
  ['batch oversized despite count below twenty', p => p.deliveryBatches[0].sizing.estimatedUnits = 100, 'DELIVERY_BATCH_SIZING'],
  ['tiny unreasoned delivery', p => p.deliveryBatches[0].sizing.estimatedUnits = 0.1, 'DELIVERY_BATCH_SIZING'],
  ['unknown dependency', p => p.deliveryBatches[1].dependsOn = ['unknown'], 'DELIVERY_BATCH_GRAPH'],
  ['cycle', p => p.deliveryBatches[0].dependsOn = ['close'], 'DELIVERY_BATCH_GRAPH'],
  ['missing original obligation', p => p.deliveryBatches[1].obligationIds = [receiverId], 'DELIVERY_BATCH_CHECKS'],
  ['source authority escape', p => p.deliveryBatches[0].allowedPaths = ['../other'], 'DELIVERY_BATCH_SCOPE'],
  ['missing proof coverage', p => p.deliveryBatches[0].checks[0].covers = [], 'DELIVERY_BATCH_CHECKS'],
  ['final check cache shortcut', p => p.deliveryBatches[1].checks[0].cacheable = true, 'DELIVERY_BATCH_CHECKS'],
  ['no attested toolchain inputs', p => p.deliveryBatches[0].checks[0].toolchainFiles = [], 'DELIVERY_BATCH_CHECKS'],
  ['late write invalidates early proof', p => p.deliveryBatches[1].writePaths = ['src'], 'DELIVERY_BATCH_PROOF_ORDER'],
  ['an Agent CLI hidden behind npx', p => p.deliveryBatches[0].checks[0].command = ['npx', 'codex', 'exec', 'implement'], 'DELIVERY_BATCH_CHECKS'],
  ['a null batch', p => p.deliveryBatches[0] = null, 'DELIVERY_BATCH_ID'],
  ['a null check', p => p.deliveryBatches[0].checks[0] = null, 'DELIVERY_BATCH_CHECKS'],
]) test(`planning rejects ${name}`, () => {
  const p = proposal(); mutate(p);
  assert.throws(() => validateDeliveryBatches(p), { code });
});

test('small necessary boundary work is allowed with explicit sizing evidence, never padded', () => {
  const p = proposal(); p.deliveryBatches[0].sizing.estimatedUnits = 0.1;
  p.deliveryBatches[0].sizing.smallBatchReason = 'An independent protected API boundary must be isolated.';
  validateDeliveryBatches(p);
});

test('deterministic commands preserve legitimate repeated argv values such as equal matrix sample counts', () => {
  const p = proposal(); p.deliveryBatches[0].checks[0].command = ['node', 'matrix.mjs', '--batches', '30', '--cold-processes', '30'];
  validateDeliveryBatches(p);
});

test('compiled Dispatch selects only its planned obligations while preserving the entire original contract', async t => {
  const f = await makeFixture(); t.after(f.cleanup);
  const [feature] = compile();
  const context = await buildImplementationContinuation({ features: [feature], submissions: [], attempts: {} }, feature, f.workspace);
  assert.deepEqual(context.workBatch.obligationIds, [receiverId]);
  assert.deepEqual(context.obligations.map(item => item.id), [receiverId]);
  assert.deepEqual(context.originalObligationSummary, { contract: 1, verification: 1 });
  assert.match(context.instructions.join(' '), /completed planned batch is a valid handoff/i);
  const p = proposal(); p.deliveryBatches[1].obligationIds = ['invented']; p.deliveryBatches[1].checks[0].covers = ['invented'];
  await assert.rejects(buildImplementationContinuation({ features: [], submissions: [], attempts: {} }, compile(p)[0], f.workspace),
    { code: 'DELIVERY_BATCH_OBLIGATION_COVERAGE' });
});

test('real behavior checks reuse only exact inputs/environment/tools/outputs; source changes and mandatory final checks rerun', async t => {
  const f = await makeFixture(); t.after(f.cleanup);
  await mkdir(resolve(f.workspace, 'src'));
  await writeFile(resolve(f.workspace, 'src/receiver.mjs'), 'export const receive = x => x * 2;');
  await writeFile(resolve(f.workspace, 'verify.mjs'), "import assert from 'node:assert/strict'; import { receive } from './src/receiver.mjs'; assert.equal(receive(4),8);");
  const check = makeCheck('behavior', [receiverId], ['src', 'verify.mjs']);
  const args = { check, workspaceRoot: f.workspace, dataRoot: f.dataRoot, controlRoot: f.harness.controlRoot,
    evidenceStore: f.harness.evidenceStore, sourceContext: { projectId: f.projectId, runId: 'fixture', epoch: 1, generation: 1, artifactDigest: null, policyDigest: 'policy' } };
  const first = await executeDeliveryCheck(args); assert.equal(first.status, 'passed'); assert.equal(first.cacheHit, false);
  assert.equal((await executeDeliveryCheck(args)).cacheHit, true);
  await writeFile(resolve(f.workspace, 'unrelated.txt'), 'unrelated source');
  assert.equal((await executeDeliveryCheck(args)).cacheHit, true);
  assert.equal((await executeDeliveryCheck({ ...args, forceFresh: true })).cacheHit, false);
  await writeFile(resolve(f.workspace, 'src/receiver.mjs'), 'export const receive = x => x * 3;');
  const failed = await executeDeliveryCheck(args); assert.equal(failed.status, 'failed'); assert.equal(failed.cacheHit, false);
  assert.match(failed.executorReceipt.payload.stderr, /AssertionError/);
});
