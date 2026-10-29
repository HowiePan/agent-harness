import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sha256 } from '../src/common/canonical.mjs';
import { buildImplementationContinuation } from '../src/application/implementation-continuation.mjs';
import { executeDeliveryCheck } from '../src/application/delivery-verification.mjs';
import { withVerificationLease } from '../src/application/delivery-verification-lease.mjs';
import { scheduleFeatures } from '../src/kernel/work-graph.mjs';
import { HarnessKernel } from '../src/kernel/kernel.mjs';
import { classifyFragmentedDeliveryHandoff } from '../src/flows/delivery-lifecycle/delivery-feedback.mjs';
import { classifyLocalIncident } from '../src/application/local-incident.mjs';
import { makeFixture, startRun, dispatchAndBind } from './test-support.mjs';
import { proposal, compile, batch, makeCheck, obligationId, receiverId, finalId } from './delivery-batch-support.mjs';

test('independent moderate lanes retain parallel scheduling while convergence waits for both and overlapping authorities remain serialized', () => {
  const p = proposal(); const right = obligationId('contract', 'Deliver independent right owner.');
  p.contracts.push('Deliver independent right owner.');
  p.deliveryBatches = [batch('left', [receiverId], { allowedPaths: ['src/left.mjs'], writePaths: ['src/left.mjs'], checks: [makeCheck('left', [receiverId], ['src/left.mjs'])] }),
    batch('right', [right], { allowedPaths: ['src/right.mjs'], writePaths: ['src/right.mjs'], checks: [makeCheck('right', [right], ['src/right.mjs'])] }),
    batch('close', [finalId], { phase: 'convergence', dependsOn: ['left', 'right'], writePaths: [], checks: [{ ...makeCheck('final', [finalId], ['src']), cacheable: false }] })];
  const features = compile(p);
  assert.equal(scheduleFeatures({ features, limit: 4 }).length, 2);
  assert.equal(features.find(item => item.metadata.deliveryBatch.id === 'close').dependsOn.length, 2);
  features[1].allowedPaths = [...features[0].allowedPaths];
  assert.equal(scheduleFeatures({ features, limit: 4 }).length, 1);
});

test('split children receive exact original certificate obligations without renaming frozen inventory producers or source lifetimes', async t => {
  const f = await makeFixture(); t.after(f.cleanup);
  const root = proposal(); root.id = 'ROOT'; root.dependsOn = ['ROOT-proof'];
  const certificateIds = Array.from({ length: 6 }, (_, i) => obligationId('aggregate-certificate', `Aggregate${i}`));
  const exitId = obligationId('source-exit', 'src/legacy.mjs');
  const child = { ...proposal(), id: 'ROOT-proof', splitFrom: root.id, contracts: ['Certify the selected cohort.'], verification: ['Execute selected receiver behavior.'],
    deliveryObligationIds: certificateIds.slice(0, 3) };
  const childIds = [...child.deliveryObligationIds, obligationId('contract', child.contracts[0]), obligationId('verification', child.verification[0])];
  child.deliveryBatches = [batch('proof', childIds, { phase: 'convergence', writePaths: [], checks: [{ ...makeCheck('proof', childIds), cacheable: false }] })];
  const all = [receiverId, finalId, ...certificateIds, exitId];
  root.deliveryBatches = [batch('close', all, { phase: 'convergence', writePaths: [], checks: [{ ...makeCheck('final', all), cacheable: false }] })];
  const inventory = { mixedAggregateContract: { aggregates: certificateIds.map((_, i) => ({ source_symbol: `Aggregate${i}`,
    complete_source_members: ['member'], member_conversions: [{ target_path: 'src/receiver.mjs' }] })), certificateProductionContract: {
    aggregateCertificates: certificateIds.map((_, i) => ({ sourceSymbol: `Aggregate${i}`, capabilityProducer: root.id,
      sourceSha256: 'a'.repeat(64), memberCount: 1, requiredAssertions: ['real-receiver'], nativeDependencies: [] })) } } };
  const expanded = { sourceLifecycleContract: { sources: [{ sourcePath: 'src/legacy.mjs', lastExitFeature: root.id, finalPaths: ['src/receiver.mjs'] }] } };
  const pin = async (path, value) => { const bytes = JSON.stringify(value); await writeFile(resolve(f.workspace, path), bytes); return { path, sha256: sha256(bytes) }; };
  const features = compile([root, child], { amendment: {}, sourceInventory: await pin('inventory.json', inventory), expandedPlan: await pin('expanded.json', expanded) });
  const native = features.find(item => item.metadata.approvedProposal.id === child.id);
  const context = await buildImplementationContinuation({ features, submissions: [], attempts: {} }, native, f.workspace);
  assert.deepEqual(context.obligations.filter(item => item.kind === 'aggregate-certificate').map(item => item.id), certificateIds.slice(0, 3));
  assert.equal(context.obligations.some(item => item.kind === 'source-exit'), false);
  assert.equal(new Set(features.map(item => item.logicalRoot)).size, 1);
  assert.equal(inventory.mixedAggregateContract.certificateProductionContract.aggregateCertificates[0].capabilityProducer, root.id);
  assert.equal(expanded.sourceLifecycleContract.sources[0].lastExitFeature, root.id);
});

test('configuration, verifier script, toolchain and output changes invalidate real verification reuse; environmental failure has no Agent fallback', async t => {
  const f = await makeFixture(); t.after(f.cleanup);
  await mkdir(resolve(f.workspace, 'src'));
  await writeFile(resolve(f.workspace, 'src/receiver.mjs'), 'export const receive = value => value * 2;');
  await writeFile(resolve(f.workspace, 'settings.json'), '{"factor":2}');
  await writeFile(resolve(f.workspace, 'toolchain.lock'), 'toolchain-v1');
  const script = "import assert from 'node:assert/strict'; import {readFileSync,mkdirSync,writeFileSync} from 'node:fs'; import {receive} from './src/receiver.mjs'; const config=JSON.parse(readFileSync('settings.json')); assert.equal(receive(4),4*config.factor); mkdirSync('.proof',{recursive:true}); writeFileSync('.proof/result.json',JSON.stringify({value:receive(4)}));";
  await writeFile(resolve(f.workspace, 'verify.mjs'), script);
  const check = { ...makeCheck('configured-api', [receiverId], ['src', 'settings.json']), outputs: ['.proof'], toolchainFiles: [process.execPath, 'toolchain.lock'] };
  const args = { check, workspaceRoot: f.workspace, excluded: ['.proof'], dataRoot: f.dataRoot, controlRoot: f.harness.controlRoot,
    evidenceStore: f.harness.evidenceStore, sourceContext: { projectId: f.projectId, runId: 'scenario', epoch: 1, generation: 1 } };
  assert.equal((await executeDeliveryCheck(args)).status, 'passed');
  assert.equal((await executeDeliveryCheck(args)).cacheHit, true);
  await writeFile(resolve(f.workspace, 'toolchain.lock'), 'toolchain-v2');
  assert.equal((await executeDeliveryCheck(args)).cacheHit, false);
  await writeFile(resolve(f.workspace, 'verify.mjs'), `${script}\n// changed check implementation`);
  assert.equal((await executeDeliveryCheck(args)).cacheHit, false);
  await writeFile(resolve(f.workspace, '.proof/result.json'), '{"value":0}');
  assert.equal((await executeDeliveryCheck(args)).cacheHit, false);
  await writeFile(resolve(f.workspace, 'settings.json'), '{"factor":3}');
  assert.equal((await executeDeliveryCheck(args)).status, 'failed');
  const unavailable = await executeDeliveryCheck({ ...args, check: { ...check, command: ['harness-fixture-missing-executable-9783'] } });
  assert.equal(unavailable.status, 'environment-failed');
  assert.equal(unavailable.executorReceipt.payload.exitCode, null);
});

test('long deterministic verification keeps its real active Lease alive and leaves the result uncommitted until checks finish', async t => {
  const f = await makeFixture(); t.after(f.cleanup);
  await startRun(f);
  const active = await dispatchAndBind(f, 'run');
  const kernel = new HarnessKernel({ authorityStore: f.harness.authorityStore,
    evidenceStore: f.harness.evidenceStore, profiles: f.harness.profileRegistry });
  await withVerificationLease({ kernel, authorityStore: f.harness.authorityStore,
    state: active.state, lease: active.lease, commandId: 'long-check-fixture', intervalMs: 20 },
  () => new Promise(resolveWait => setTimeout(resolveWait, 100)));
  const state = await f.harness.authorityStore.read(f.projectId, 'run');
  assert(state.leases[0].heartbeatCount >= 2);
  assert.equal(state.leases[0].progress, 'delivery-verification');
  assert.equal(state.submissions.length, 0);
});

for (const target of ['V1.2.0', 'V9.0.0']) test(`the same bounded policy compiles a later version ${target} without project/version-specific branches`, () => {
  const p = proposal(); p.id = `${target}/feature`; p.contracts = ['Deliver working receiver and consumer.'];
  const features = compile(p);
  assert.equal(features.length, 2); assert(features.every(item => item.logicalRoot.endsWith(p.id)));
});

test('repeated voluntary slices require a bounded sizing review; actual check failures, external blocks and prior-plan history do not force planning', () => {
  const [feature] = compile();
  const partial = { status: 'blocked', summary: 'Only one slice delivered.', failureClass: 'implementation-incomplete',
    blocker: { kind: 'implementation', summary: 'Batch remains incomplete.' }, changedFiles: ['src/receiver.mjs'] };
  const state = { submissions: [1, 2].map(i => ({ submissionId: `s${i}`, dispatchId: `d${i}`, featureId: feature.id,
    evidenceRefs: ['bound-native-evidence'], result: partial })), dispatches: [1, 2].map(i => ({ dispatchId: `d${i}`,
    execution: { implementationContinuation: { workBatch: feature.metadata.deliveryBatch } } })) };
  assert.equal(classifyFragmentedDeliveryHandoff(state, feature, partial).failureClass, 'implementation-sizing-review');
  const observed = { ...partial, observations: ['Host verification evidence: sealed-check'] };
  assert.equal(classifyFragmentedDeliveryHandoff(state, feature, observed), observed);
  const external = { ...partial, failureClass: 'external', blocker: { kind: 'external' } };
  assert.equal(classifyFragmentedDeliveryHandoff(state, feature, external), external);
  state.dispatches = [];
  assert.equal(classifyFragmentedDeliveryHandoff(state, feature, partial), partial);
});

test('known sizing and maintenance freezes are planning attention, never a provisional Harness defect or routine full Replan', () => {
  for (const error of ['DELIVERY_BATCH_SIZING_REVIEW_REQUIRED', 'RUN_EXECUTION_FROZEN']) {
    const incident = classifyLocalIncident({ error, action: 'implement' });
    assert.equal(incident.origin, 'project'); assert.equal(incident.severityStatus, 'classified');
    assert.match(incident.continuation, /bounded-amendment/);
    assert.equal(incident.maintenanceContext, null);
  }
});
