import assert from 'node:assert/strict';
import test from 'node:test';
import { expandApprovedImplementation } from '../src/flows/delivery-lifecycle/approved-implementation.mjs';
import { deliveryLifecycleProfile } from '../src/flows/delivery-lifecycle/policy/delivery-lifecycle.mjs';
import { implementNode } from '../src/flows/delivery-lifecycle/nodes/implement/index.mjs';
import { digestJson } from '../src/common/canonical.mjs';
import { createDispatchResultContract, validateBusinessResult } from '../src/platform/execution/result-contract.mjs';

const parent = {
  id: 'implement/V1', kind: 'implement', executionClass: 'agent-reasoning', logicalRoot: 'implement:V1',
  acceptance: ['Implement approved scope.'], task: implementNode.task, dependsOn: [],
  allowedPaths: ['src', 'tests', 'docs'], forbiddenPaths: ['.git'], contracts: [], gatePlan: [],
  metadata: { stage: 'implementation', target: 'V1', workflow: { nodeId: 'implement' }, outputPorts: { implement: 'delivery-implementation-v1' } },
};
const proposal = (id, dependsOn = []) => ({ id, projectId: 'engine', disposition: 'project-owned', dependsOn,
  allowedPaths: ['src'], contracts: [`${id} contract`], verification: [`${id} check`] });

test('approved implementation schedules project-owned proposals serially and excludes external work', () => {
  const typedPlan = { proposedFeatures: [proposal('F00'), proposal('F02', ['F01']), proposal('F01', ['F00']),
    { ...proposal('COL'), projectId: 'collection', disposition: 'cross-project-dependency' }] };
  const scope = { ...parent, id: 'scope/V1', metadata: { stage: 'scope-resolution' }, dependsOn: [parent.id] };
  const features = expandApprovedImplementation({ features: [parent, scope], typedPlan, projectId: 'engine' });
  assert.deepEqual(features.map(item => item.id), ['implement/V1/F00', 'implement/V1/F01', 'implement/V1/F02', 'scope/V1']);
  assert.deepEqual(features[1].dependsOn, ['implement/V1/F00']);
  assert.deepEqual(features[2].dependsOn, ['implement/V1/F01']);
  assert.deepEqual(features[3].dependsOn, ['implement/V1/F02']);
  assert.deepEqual(features[0].allowedPaths, ['src', 'tests', 'docs']);
  assert.equal(features[0].metadata.approvedProposal.id, 'F00');
  assert.equal(features[0].attemptLimit, 21);
  assert.match(features[0].task.instructions.join(' '), /whole-project check fails only in files owned by another proposal/);
  assert.match(features[0].task.instructions.join(' '), /fresh final Gates after all proposals/);
});

test('approved implementation preserves hierarchical proposal IDs and dependencies', () => {
  const typedPlan = { proposedFeatures: [proposal('V3.9.0/F-00'), proposal('V3.9.0/F-13-core', ['V3.9.0/F-00'])] };
  const features = expandApprovedImplementation({ features: [parent], typedPlan, projectId: 'engine' });
  assert.deepEqual(features.map(item => item.id), ['implement/V1/V3.9.0/F-00', 'implement/V1/V3.9.0/F-13-core']);
  assert.deepEqual(features[1].dependsOn, ['implement/V1/V3.9.0/F-00']);
  assert.equal(features[0].metadata.approvedProposal.id, 'V3.9.0/F-00');
});

test('implementation approval context binds the exact plan without granting its proposed paths', () => {
  const typedPlan = { proposedFeatures: [proposal('F00')] };
  const approvalBinding = { projectId: 'engine', runId: 'reviewed-run', planDigest: 'a'.repeat(64),
    artifactDigest: 'b'.repeat(64), sourceDigest: 'c'.repeat(64), typedPlan,
    approvalDecision: { id: 'implementation-plan-approved', actor: 'user', decision: 'approved',
      projectId: 'engine', runId: 'reviewed-run', planDigest: 'a'.repeat(64), artifactDigest: 'b'.repeat(64) } };
  const input = { features: [parent], typedPlan, projectId: 'engine', approvalBinding };
  const expanded = expandApprovedImplementation(input)[0];
  assert.deepEqual(expanded.metadata.approvedPlanBinding.approvalDecision, approvalBinding.approvalDecision);
  assert.equal(expanded.metadata.approvedPlanBinding.typedPlanDigest, digestJson(typedPlan));
  assert.equal(expanded.metadata.approvedPlanBinding.typedPlan, undefined);
  assert.deepEqual(expanded.allowedPaths, parent.allowedPaths);
  assert(expanded.task.inputs.some(item => item.id === 'approved-plan-binding' && item.path === 'approvedPlanBinding'));
  for (const altered of [{ ...approvalBinding, projectId: 'other' }, { ...approvalBinding, typedPlan: {} },
    { ...approvalBinding, artifactDigest: 'invalid' }]) {
    assert.throws(() => expandApprovedImplementation({ ...input, approvalBinding: altered }),
      error => error.code === 'IMPLEMENTATION_APPROVAL_BINDING_MISMATCH');
  }
});

test('proposal IDs reject ambiguous segments and duplicates during planning', () => {
  const planning = { metadata: { stage: 'version-planning' } };
  const completed = proposedFeatures => ({ status: 'completed', outputs: { plan: { value: { proposedFeatures } } } });
  const validate = proposedFeatures => deliveryLifecycleProfile.validateResult({
    state: { projectId: 'engine' }, feature: planning, result: completed(proposedFeatures),
  });
  assert.equal(validate([proposal('V3.9.0/F-00')]).ok, true);
  for (const id of ['V3.9.0//F-00', 'V3.9.0/../F-00', '/F-00', 'F-00/', 'F\\00']) {
    assert.deepEqual(validate([proposal(id)]), { ok: false, reason: 'planning-proposal-id-invalid' });
  }
  assert.deepEqual(validate([proposal('F-00'), proposal('F-00')]), { ok: false, reason: 'planning-proposal-id-invalid' });
});

test('proposal completion requires its exact identity and contract verification evidence', () => {
  const feature = expandApprovedImplementation({ features: [parent], typedPlan: { proposedFeatures: [proposal('F00')] }, projectId: 'engine' })[0];
  const result = { status: 'completed', outputs: { implement: { value: { proposalId: 'F00', completedContracts: ['F00 contract'],
    verificationResults: [{ item: 'F00 check', status: 'completed', evidenceRefs: ['evidence:focused-test'] }] } } } };
  assert.equal(deliveryLifecycleProfile.validateResult({ state: {}, feature, result }).ok, true);
  const passed = structuredClone(result);
  passed.outputs.implement.value.verificationResults[0].status = 'passed';
  assert.match(deliveryLifecycleProfile.validateResult({ state: {}, feature, result: passed }).reason,
    /successful entries require status completed and non-empty evidenceRefs/);
  assert.equal(deliveryLifecycleProfile.validateResult({ state: {}, feature, result: { ...result, outputs: { implement: { value: { ...result.outputs.implement.value, proposalId: 'F01' } } } } }).ok, false);
  assert.equal(deliveryLifecycleProfile.validateResult({ state: {}, feature, result: { ...result, outputs: { implement: { value: { ...result.outputs.implement.value, verificationResults: [] } } } } }).ok, false);
});

test('external verification may be deferred only against an approved prerequisite', () => {
  const externalPrerequisite = 'Receive the independent Collection artifact receipt';
  const approved = { ...proposal('F08'), externalPrerequisites: [externalPrerequisite] };
  const feature = expandApprovedImplementation({ features: [parent], typedPlan: { proposedFeatures: [approved] }, projectId: 'engine' })[0];
  const value = { proposalId: 'F08', completedContracts: ['F08 contract'], verificationResults: [
    { item: 'F08 check', status: 'deferred', externalPrerequisite, reason: 'The separate Collection project has not published its receipt.' },
  ] };
  assert.equal(deliveryLifecycleProfile.validateResult({ state: {}, feature, result: { status: 'completed', outputs: { implement: { value } } } }).ok, true);
  assert.equal(deliveryLifecycleProfile.validateResult({ state: {}, feature, result: { status: 'completed', outputs: { implement: { value: { ...value,
    verificationResults: [{ ...value.verificationResults[0], externalPrerequisite: 'unapproved' }] } } } } }).ok, false);
});

test('object verification survives JSON transport and object key reordering', () => {
  const item = { capabilityProducer: 'F00', specificationRef: 'docs/plan.json#/verification/0' };
  const approved = { ...proposal('F00'), verification: [item] };
  const feature = expandApprovedImplementation({ features: [parent],
    typedPlan: { proposedFeatures: [approved] }, projectId: 'engine' })[0];
  createDispatchResultContract(feature);
  const result = JSON.parse(JSON.stringify({ status: 'completed', summary: 'Verified object contract.',
    changedFiles: [], outputs: { implement: { schemaId: 'delivery-implementation-v1',
      evidenceRefs: ['evidence:test'], value: { proposalId: 'F00', changedFiles: [],
        completedContracts: ['F00 contract'], verificationResults: [{
          item: { specificationRef: item.specificationRef, capabilityProducer: item.capabilityProducer },
          status: 'completed', evidenceRefs: ['evidence:focused-test'],
        }] } } } }));
  const transported = validateBusinessResult(result, { conversationVisible: true, feature });
  assert.notEqual(transported.outputs.implement.value.verificationResults[0].item, item);
  assert.equal(deliveryLifecycleProfile.validateResult({ state: {}, feature, result: transported }).ok, true);

  const verify = entries => deliveryLifecycleProfile.validateResult({ state: {}, feature,
    result: { ...result, outputs: { implement: { value: {
      ...result.outputs.implement.value, verificationResults: entries,
    } } } } });
  const entry = result.outputs.implement.value.verificationResults[0];
  for (const entries of [[], [entry, structuredClone(entry)], [{}],
    [{ ...entry, item: { ...item, capabilityProducer: 'F01' } }],
    [{ ...entry, item: { ...item, specificationRef: 'docs/plan.json#/verification/1' } }],
    [{ ...entry, item: { ...item, extra: true } }],
    [{ ...entry, evidenceRefs: [] }], [{ ...entry, status: 'deferred' }],
  ]) assert.equal(verify(entries).ok, false);
  assert.match(verify([{ ...entry, status: 'passed' }]).reason,
    /successful entries require status completed and non-empty evidenceRefs/);
});

test('object verification cannot substitute duplicate evidence for a distinct approved item', () => {
  const first = { capabilityProducer: 'F00', specificationRef: 'docs/plan.json#/verification/0' };
  const second = { ...first, specificationRef: 'docs/plan.json#/verification/1' };
  const approved = { ...proposal('F00'), verification: [first, second], externalPrerequisites: ['receiver'] };
  const feature = expandApprovedImplementation({ features: [parent],
    typedPlan: { proposedFeatures: [approved] }, projectId: 'engine' })[0];
  const completed = item => ({ item: structuredClone(item), status: 'completed', evidenceRefs: ['evidence:test'] });
  const verify = verificationResults => deliveryLifecycleProfile.validateResult({ state: {}, feature,
    result: { status: 'completed', outputs: { implement: { value: {
      proposalId: 'F00', completedContracts: ['F00 contract'], verificationResults,
    } } } } }).ok;
  assert.equal(verify([completed(first), completed(second)]), true);
  assert.equal(verify([completed(first), completed(first)]), false);
  const deferred = { item: structuredClone(second), status: 'deferred', externalPrerequisite: 'receiver', reason: 'Await receiver.' };
  assert.equal(verify([completed(first), deferred]), true);
  assert.equal(verify([completed(first), { ...deferred, externalPrerequisite: 'other' }]), false);
  assert.equal(verify([completed(first), { ...deferred, reason: ' ' }]), false);
});

test('approved implementation rejects missing or cyclic project-owned dependencies', () => {
  assert.throws(() => expandApprovedImplementation({ features: [parent], typedPlan: { proposedFeatures: [proposal('F01', ['COL'])] }, projectId: 'engine' }),
    { code: 'IMPLEMENTATION_PROPOSAL_DEPENDENCY_INVALID' });
  assert.throws(() => expandApprovedImplementation({ features: [parent], typedPlan: { proposedFeatures: [proposal('F00', ['F01']), proposal('F01', ['F00'])] }, projectId: 'engine' }),
    { code: 'IMPLEMENTATION_PROPOSAL_CYCLE' });
});

test('approved proposal Dispatch publishes the exact completion Schema before execution', () => {
  const approved = { ...proposal('F00'), externalPrerequisites: ['Independent receiver receipt'] };
  const feature = expandApprovedImplementation({ features: [parent],
    typedPlan: { proposedFeatures: [approved] }, projectId: 'engine' })[0];
  const contract = createDispatchResultContract(feature, { conversationVisible: true });
  assert.equal(contract.outputValueSchemas.implement.properties.proposalId.const, 'F00');
  assert.match(feature.task.instructions.join(' '), /Successful verification entries must use status completed/);
  const value = { changedFiles: [], proposalId: 'F00', completedContracts: ['F00 contract'],
    verificationResults: [{ item: 'F00 check', status: 'completed', evidenceRefs: ['evidence:test'] }] };
  const validate = candidate => validateBusinessResult({ status: 'completed', summary: 'Verified proposal.',
    changedFiles: [], outputs: { implement: { schemaId: 'delivery-implementation-v1',
      value: candidate, evidenceRefs: ['evidence:test'] } } }, { conversationVisible: true, feature });
  assert.equal(validate(value).status, 'completed');
  for (const candidate of [
    { ...value, proposalId: 'F01' }, { ...value, completedContracts: [] },
    { ...value, verificationResults: [] },
    { ...value, verificationResults: [{ ...value.verificationResults[0], status: 'passed' }] },
    { ...value, verificationResults: [{ ...value.verificationResults[0], evidenceRefs: [] }] },
    { ...value, verificationResults: [{ item: 'F00 check', status: 'deferred',
      externalPrerequisite: 'unapproved', reason: 'Missing receipt.' }] },
  ]) assert.throws(() => validate(candidate), error => error.code === 'RESULT_OUTPUT_VALUE_SCHEMA_INVALID');
  const deferred = { ...value, verificationResults: [{ item: 'F00 check', status: 'deferred',
    externalPrerequisite: approved.externalPrerequisites[0], reason: 'Independent project has not supplied its receipt.' }] };
  assert.equal(validate(deferred).status, 'completed');
  assert.equal(deliveryLifecycleProfile.validateResult({ state: {}, feature, result: validate(deferred) }).ok, true);
  assert.throws(() => validate({ ...deferred, verificationResults: [{ ...deferred.verificationResults[0], reason: '  ' }] }),
    error => error.code === 'RESULT_OUTPUT_VALUE_SCHEMA_INVALID');
});

test('completion Schema supports no verification items and leaves generic implementation unchanged', () => {
  const approved = { ...proposal('F00'), contracts: [], verification: [] };
  const feature = expandApprovedImplementation({ features: [parent],
    typedPlan: { proposedFeatures: [approved] }, projectId: 'engine' })[0];
  createDispatchResultContract(feature);
  const result = { status: 'completed', summary: 'Verified empty proposal.', changedFiles: [], outputs: {
    implement: { schemaId: 'delivery-implementation-v1', evidenceRefs: ['evidence:test'],
      value: { changedFiles: [], proposalId: 'F00', completedContracts: [], verificationResults: [] } },
  } };
  assert.equal(validateBusinessResult(result, { feature }).status, 'completed');
  assert.equal(deliveryLifecycleProfile.validateResult({ state: {}, feature, result }).ok, true);
  assert.equal(parent.metadata.outputValueSchemas, undefined);
});
