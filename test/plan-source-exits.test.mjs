import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAmendmentGraph } from '../src/flows/delivery-lifecycle/plan-amendment.mjs';
import { createDeliveryLifecycleProfile } from '../src/flows/delivery-lifecycle/policy/delivery-lifecycle.mjs';
import { proposal } from './delivery-batch-support.mjs';

const work = (id, dependsOn = []) => ({ ...proposal(), id, dependsOn });
const ref = (proposalId, batchId = 'receiver', checkId = 'receiver') => ({ proposalId, batchId, checkId });

const exitPlan = () => {
  const producer = work('replacement');
  const consumer = work('legacy-tests', [producer.id]);
  const retire = work('retire', [consumer.id]);
  const verify = work('full-verification', [retire.id]);
  const [exit] = retire.deliveryBatches;
  exit.phase = 'source-exit';
  exit.writePaths = ['src/legacy.mjs'];
  exit.sourceExits = [{ path: 'src/legacy.mjs', inventoryRef: 'docs/migration.json#/legacy',
    beforeChecks: [ref(producer.id), ref(consumer.id)], afterChecks: [ref(verify.id, 'close', 'final')] }];
  return { proposedFeatures: [producer, consumer, retire, verify] };
};

test('a new source-exit plan proves replacement and consumer migration before retirement and fresh full checks after', () => {
  const plan = exitPlan();
  const [,, retire] = plan.proposedFeatures;
  const profile = createDeliveryLifecycleProfile();
  const submit = () => profile.validateResult({ state: { projectId: 'project' }, feature: { metadata: { stage: 'version-planning' } },
    result: { status: 'completed', outputs: { plan: { value: plan } } } });
  assert.deepEqual(submit(), { ok: true });
  delete retire.deliveryBatches[0].sourceExits;
  assert.match(submit().reason, /PLAN_SOURCE_EXIT_REQUIRED.*retire\/receiver/u);
  assert.doesNotThrow(() => validateAmendmentGraph(plan), 'unchanged archived plans remain readable');
});

test('the amended full graph rejects unordered consumers, unowned exit paths, and stale or missing checks', () => {
  const cases = [
    ['PLAN_SOURCE_EXIT_ORDER', ([producer,, retire]) => { retire.dependsOn = [producer.id]; }],
    ['PLAN_SOURCE_EXIT_INVALID', ([,, retire]) => { retire.deliveryBatches[0].writePaths = ['src']; }],
    ['PLAN_SOURCE_EXIT_ORDER', ([,,, verify]) => { verify.deliveryBatches[1].checks[0].cacheable = true; }],
    ['PLAN_SOURCE_EXIT_CHECK_MISSING', ([,,, verify]) => { verify.deliveryBatches[1].checks[0].id = 'renamed'; }],
    ['PLAN_SOURCE_EXIT_ORDER', ([,, retire]) => { retire.deliveryBatches[0].sourceExits[0].afterChecks = [ref('replacement')]; }],
  ];
  for (const [code, change] of cases) {
    const plan = exitPlan();
    change(plan.proposedFeatures);
    assert.throws(() => validateAmendmentGraph(plan), { code });
  }
});

test('a broad early check with a later test producer is rejected before approval and exposes a cycle if wired directly', () => {
  const diagnostics = work('diagnostics');
  const spatial = work('spatial', [diagnostics.id]);
  const lexicon = work('lexicon', [spatial.id]);
  const plan = { proposedFeatures: [diagnostics, spatial, lexicon] };
  const broad = diagnostics.deliveryBatches[0].checks[0];
  broad.requiresProposals = [lexicon.id];
  assert.throws(() => validateAmendmentGraph(plan), /diagnostics\/receiver\/receiver requires lexicon/u);
  diagnostics.dependsOn = [lexicon.id];
  assert.throws(() => validateAmendmentGraph(plan), /diagnostics -> lexicon -> spatial -> diagnostics/u);
  diagnostics.dependsOn = [];
  delete broad.requiresProposals;
  const full = work('full-verification', [lexicon.id]);
  full.deliveryBatches[1].checks[0].requiresProposals = [lexicon.id, diagnostics.id];
  plan.proposedFeatures.push(full);
  assert.doesNotThrow(() => validateAmendmentGraph(plan));
});

test('a downstream proposal cannot serve as a local check or producer', () => {
  const plan = exitPlan();
  const [producer, consumer] = plan.proposedFeatures;
  producer.disposition = 'cross-project-dependency';
  assert.throws(() => validateAmendmentGraph(plan), { code: 'PLAN_SOURCE_EXIT_CHECK_MISSING' });
  consumer.deliveryBatches[0].checks[0].requiresProposals = [producer.id];
  assert.throws(() => validateAmendmentGraph(plan), { code: 'PLAN_CHECK_PREREQUISITE_ORDER' });
});
