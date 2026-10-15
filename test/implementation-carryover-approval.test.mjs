import test from 'node:test';
import assert from 'node:assert/strict';
import { digestJson } from '../src/common/canonical.mjs';
import { resolveCarryoverApproval } from '../src/application/implementation-carryover-approval.mjs';
import { expandApprovedImplementation } from '../src/flows/delivery-lifecycle/approved-implementation.mjs';
import { implementationGraphDigest } from '../src/kernel/completion-carryover.mjs';
import { implementNode } from '../src/flows/delivery-lifecycle/nodes/implement/index.mjs';

const fixture = () => {
  const sourceDigest = 'a'.repeat(64);
  const original = { projectId: 'project', runId: 'approved-plan', planDigest: 'b'.repeat(64),
    artifactDigest: 'c'.repeat(64), sourceDigest: 'd'.repeat(64), originalSourceDigest: 'e'.repeat(64),
    typedPlan: { proposedFeatures: ['A00', 'A01', 'layout'].map((id, index, ids) => ({
      id, projectId: 'project', disposition: 'project-owned', dependsOn: index ? [ids[index - 1]] : [],
      contracts: ['approved contract'], verification: ['approved check'], allowedPaths: ['src'],
    })) }, approvalDecision: { id: 'implementation-plan-approved', actor: 'user', decision: 'approved' },
    sourceCompatibility: { mode: 'verified-prior-implementation', priorRunId: 'earlier-run' } };
  const input = { projectId: 'project', runId: 'replacement', sourceDigest,
    completionCarryover: { priorRunId: 'prior', carryoverDigest: 'f'.repeat(64) },
    metadata: { lifecyclePlanDigest: '1'.repeat(64) } };
  const prior = { projectId: 'project', runId: 'prior', sourceDigest, status: 'superseded', metadata: {
    approvedPlan: original, supersededByRunId: input.runId, supersedePlanDigest: input.metadata.lifecyclePlanDigest,
    completionCarryover: { plan: { replacementRunId: input.runId,
      replacementPlanDigest: input.metadata.lifecyclePlanDigest, sourceDigest,
      carryoverDigest: input.completionCarryover.carryoverDigest } },
  } };
  const currentApproval = { ...structuredClone(original), sourceDigest,
    sourceCompatibility: { mode: 'verified-prior-implementation', priorRunId: 'prior', toSourceDigest: sourceDigest } };
  return { input, prior, currentApproval, original };
};

test('fresh source assessment preserves the sealed approval and exact expanded Feature graph', () => {
  const f = fixture();
  const parent = { id: 'implement/V1', logicalRoot: 'implement:V1', executionClass: 'agent-reasoning',
    task: implementNode.task, dependsOn: [], allowedPaths: ['src'], forbiddenPaths: ['.git'], contracts: [],
    metadata: { stage: 'implementation', target: 'V1', workflow: { nodeId: 'implement' } } };
  const expand = approvalBinding => expandApprovedImplementation({ features: [parent],
    typedPlan: f.original.typedPlan, projectId: 'project', approvalBinding });
  const sealed = implementationGraphDigest(expand(f.original));
  assert.notEqual(implementationGraphDigest(expand(f.currentApproval)), sealed);
  const resolved = resolveCarryoverApproval(f);
  assert.equal(implementationGraphDigest(expand(resolved)), sealed);
  assert.deepEqual(resolved, f.original);
  assert.notEqual(resolved, f.original);
  assert.equal(f.currentApproval.sourceDigest, f.input.sourceDigest);
  const alteredGraph = expand(resolved);
  alteredGraph[0].allowedPaths.push('outside');
  assert.notEqual(implementationGraphDigest(alteredGraph), sealed);
});

test('carry-over rejects changed approval identity, user Decision and typed proposal bytes', () => {
  for (const field of ['projectId', 'runId', 'planDigest', 'artifactDigest', 'originalSourceDigest',
    'approvalDecision', 'typedPlan']) {
    const f = fixture();
    f.currentApproval[field] = { changed: field };
    assert.throws(() => resolveCarryoverApproval(f), error => error.code === 'CARRYOVER_APPROVAL_IDENTITY_CHANGED');
  }
  const f = fixture();
  delete f.currentApproval.approvalDecision;
  assert.throws(() => resolveCarryoverApproval(f), error => error.code === 'CARRYOVER_APPROVAL_IDENTITY_CHANGED');
});

test('carry-over approval requires the exact retired claim and unchanged authoritative source', () => {
  const mutations = [f => { f.prior.status = 'running'; }, f => { f.prior.projectId = 'other'; },
    f => { f.prior.runId = 'other'; }, f => { f.prior.sourceDigest = '0'.repeat(64); },
    f => { f.prior.metadata.supersededByRunId = 'other'; },
    f => { f.prior.metadata.supersedePlanDigest = '0'.repeat(64); },
    ...['replacementRunId', 'replacementPlanDigest', 'carryoverDigest', 'sourceDigest'].map(field =>
      f => { f.prior.metadata.completionCarryover.plan[field] = 'different'; })];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    assert.throws(() => resolveCarryoverApproval(f), error => error.code === 'CARRYOVER_APPROVAL_CLAIM_MISMATCH');
  }
  const f = fixture();
  const before = digestJson(f);
  resolveCarryoverApproval(f);
  assert.equal(digestJson(f), before);
});
