import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { makeFixture, startRun, dispatchAndBind, recordResult, command } from './test-support.mjs';
import { compile, completion, receiverId } from './delivery-batch-support.mjs';

const fixture = async t => {
  const f = await makeFixture({ profiles: ['engine-delivery'] }); t.after(f.cleanup);
  await mkdir(resolve(f.workspace, 'src'));
  await writeFile(resolve(f.workspace, 'src/receiver.mjs'), 'export const receive = x => x * 3;');
  await writeFile(resolve(f.workspace, 'verify.mjs'), "import assert from 'node:assert/strict'; import {receive} from './src/receiver.mjs'; assert.equal(receive(4),8);");
  const features = compile();
  await startRun(f, { profileId: 'engine-delivery', features, profileConfig: { requireCanonicalDecision: false } });
  return { ...f, features };
};

test('managed source delivery completes its own batch; a distinct Dispatch then converges original acceptance with fresh final verification', async t => {
  const f = await fixture(t);
  const first = await dispatchAndBind(f, 'run');
  assert.equal(first.dispatch.featureId, f.features[0].id);
  await writeFile(resolve(f.workspace, 'src/receiver.mjs'), 'export const receive = x => x * 2;');
  const result = completion(f.features[0], ['src/receiver.mjs']);
  let state = (await recordResult(f, 'run', first.dispatch, result)).state;
  assert.equal(state.features[0].state, 'completed'); assert.equal(state.features[1].state, 'pending');
  assert.equal(state.submissions.length, 1);
  const second = await dispatchAndBind(f, 'run');
  assert.notEqual(first.dispatch.dispatchId, second.dispatch.dispatchId);
  assert.equal(second.dispatch.featureId, f.features[1].id);
  state = (await recordResult(f, 'run', second.dispatch, completion(f.features[1]))).state;
  assert(state.features.every(item => item.state === 'completed'));
  const evidence = await f.harness.evidenceStore.read(state.submissions.at(-1).evidenceRefs[0]);
  const checks = JSON.parse(evidence.bytes).runtimeEvidence.deliveryVerification;
  assert.equal(checks.length, 2);
  assert.equal(checks.find(item => item.checkId === 'receiver').cacheHit, true);
  assert.equal(checks.find(item => item.checkId === 'final').cacheHit, false);
});

test('false completed claim becomes a real observed batch failure; source repair stays in the same bounded batch and original budget', async t => {
  const f = await fixture(t);
  const first = await dispatchAndBind(f, 'run');
  let state = (await recordResult(f, 'run', first.dispatch, completion(f.features[0]))).state;
  assert.equal(state.features[0].state, 'blocked');
  assert.equal(state.features[1].state, 'pending');
  assert.equal(state.submissions.at(-1).result.failureClass, 'implementation-incomplete');
  assert(!state.submissions.at(-1).result.checkpoints.some(item => item.id === receiverId));
  const record = JSON.parse((await f.harness.evidenceStore.read(state.submissions.at(-1).evidenceRefs[0])).bytes);
  assert.equal(record.nativeResult.status, 'completed');
  assert.equal(record.result.status, 'blocked');
  assert.equal(record.runtimeEvidence.deliveryVerification[0].status, 'failed');
  state = (await f.harness.kernel.reopenFeature(f.projectId, 'run', { featureId: f.features[0].id,
    reason: 'Repair independently reproduced behavior mismatch.' }, command(state))).state;
  const retry = await dispatchAndBind(f, 'run');
  assert.equal(retry.dispatch.featureId, first.dispatch.featureId);
  await writeFile(resolve(f.workspace, 'src/receiver.mjs'), 'export const receive = x => x * 2;');
  state = (await recordResult(f, 'run', retry.dispatch, completion(f.features[0], ['src/receiver.mjs']))).state;
  assert.equal(state.features[0].state, 'completed');
  assert.equal(Object.values(state.attempts)[0].failures, 1);
});

test('claims cannot skip assigned obligations even when the real command happens to pass', async t => {
  const f = await fixture(t);
  const first = await dispatchAndBind(f, 'run');
  const bad = completion(f.features[0]); bad.checkpoints = [];
  await assert.rejects(recordResult(f, 'run', first.dispatch, bad), { code: 'DELIVERY_BATCH_ACCEPTANCE_INCOMPLETE' });
  const state = await f.harness.authorityStore.read(f.projectId, 'run');
  assert.equal(state.submissions.length, 0);
  assert.equal(state.features[1].state, 'pending');
});
