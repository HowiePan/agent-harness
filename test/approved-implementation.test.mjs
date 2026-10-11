import assert from 'node:assert/strict';
import test from 'node:test';
import { expandApprovedImplementation } from '../src/flows/delivery-lifecycle/approved-implementation.mjs';
import { deliveryLifecycleProfile } from '../src/flows/delivery-lifecycle/policy/delivery-lifecycle.mjs';
import { implementNode } from '../src/flows/delivery-lifecycle/nodes/implement/index.mjs';

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

test('approved implementation rejects missing or cyclic project-owned dependencies', () => {
  assert.throws(() => expandApprovedImplementation({ features: [parent], typedPlan: { proposedFeatures: [proposal('F01', ['COL'])] }, projectId: 'engine' }),
    { code: 'IMPLEMENTATION_PROPOSAL_DEPENDENCY_INVALID' });
  assert.throws(() => expandApprovedImplementation({ features: [parent], typedPlan: { proposedFeatures: [proposal('F00', ['F01']), proposal('F01', ['F00'])] }, projectId: 'engine' }),
    { code: 'IMPLEMENTATION_PROPOSAL_CYCLE' });
});
