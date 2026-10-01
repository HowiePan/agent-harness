import assert from 'node:assert/strict';
import test from 'node:test';
import { digestJson } from '../src/common/canonical.mjs';
import { deriveLogicalTaskKey } from '../src/application/lifecycle-command-plan.mjs';
import { resolveRunLineage } from '../src/application/lineage.mjs';
import { diffPlanFeatures, preparePlanRevisionIntent } from '../src/application/plan-revision.mjs';
import { planApprovalSnapshot, planApprovalSatisfied } from '../src/flows/delivery-lifecycle/plan-approval.mjs';

const source = 'a'.repeat(64);
const nextSource = 'b'.repeat(64);
const oldDigest = 'c'.repeat(64);
const currentPlan = { proposedFeatures: [{ id: 'F04', projectId: 'engine', disposition: 'project-owned', allowedPaths: ['src/view.rs'], dependsOn: [], contracts: ['private projection'], verification: ['privacy test'] }] };
const reviewed = ({ approved = false, status = 'closure-blocked', leases = [], dispatches = [] } = {}) => {
  const body = {
    projectId: 'engine', runId: 'old-plan', revision: 8, status, sourceDigest: source,
    updatedAt: '2026-09-29T12:00:00.000Z', profile: { id: 'engine-delivery' }, leases, dispatches,
    features: [{ id: 'plan/V1', state: 'completed', metadata: { stage: 'version-planning' } }, { id: 'plan-review/V1', state: 'completed', metadata: { stage: 'plan-review' } }],
    submissions: [
      { featureId: 'plan/V1', result: { status: 'completed', outputs: { plan: { value: currentPlan } } } },
      { featureId: 'plan-review/V1', result: { status: 'completed', outputs: { 'plan-review': { value: { approved, findings: approved ? [] : ['F04 missing public projection path'] } } } } },
    ],
    decisions: [], metadata: { logicalTaskKey: 'd'.repeat(64), lifecyclePlanDigest: oldDigest, commandIntent: { action: 'plan', target: 'V1', workflowId: 'engine-delivery', preset: 'default' } },
  };
  return { ...body, authorityDigest: digestJson(body) };
};

const planned = ({ action = 'plan', sourceDigest = nextSource, parent = null } = {}) => ({
  project: { id: 'engine' }, logicalTaskKey: 'd'.repeat(64), planDigest: 'e'.repeat(64),
  intent: { action, target: 'V1', workflowId: 'engine-delivery', profileId: 'engine-delivery', preset: 'default', ...(parent ? { planRevision: parent } : {}) },
  run: { runId: 'next-plan', profileId: 'engine-delivery', sourceDigest, agentExecutionMode: 'conversation-visible' },
});

test('plan and replan share one target lineage even when a change selector is present', () => {
  const basis = { projectId: 'engine', executionWorkspaceRoot: 'F:/engine', intent: { action: 'plan', target: 'V1', workflowId: 'engine-delivery', profileId: 'engine-delivery', preset: 'default' } };
  const key = deriveLogicalTaskKey(basis);
  assert.equal(deriveLogicalTaskKey({ ...basis, intent: { ...basis.intent, action: 'replan', preset: 'change', selector: 'CR-1' } }), key);
  assert.notEqual(deriveLogicalTaskKey({ ...basis, intent: { ...basis.intent, target: 'V2' } }), key);
});

test('a rejected plan may be replaced after source correction but an approved pending plan may not be silently replaced', () => {
  const rejected = reviewed();
  const resolution = resolveRunLineage({ plan: planned(), states: [rejected] });
  assert.equal(resolution.action, 'supersede-and-start');
  assert.equal(resolution.reasonCode, 'REJECTED_PLAN_SOURCE_REPLANNED');
  assert.equal(resolveRunLineage({ plan: planned({ sourceDigest: source }), states: [rejected] }).action, 'block');
  assert.equal(resolveRunLineage({ plan: planned(), states: [reviewed({ approved: true })] }).action, 'block');
  const live = reviewed({ leases: [{ leaseId: 'live', status: 'active', lastHeartbeatAt: new Date().toISOString(), heartbeatTimeoutMs: 120000 }] });
  assert.equal(resolveRunLineage({ plan: planned(), states: [live] }).reasonCode, 'INCOMPATIBLE_LIVE_LEASE');
});

test('replan requires a reviewed parent, pins its Authority, and accepts a declared requirement change', () => {
  const parent = reviewed({ approved: true, status: 'closed' });
  const intent = { action: 'replan', target: 'V1', workflowId: 'engine-delivery', profileId: 'engine-delivery', preset: 'change', selector: 'CR-1' };
  const project = { policy: { planChangeRequests: { 'CR-1': { target: 'V1', kind: 'add', summary: 'Add privacy audit', requirements: ['Mask event counts'], acceptance: ['Viewer cannot infer hidden actions'] } } } };
  const revision = preparePlanRevisionIntent({ intent, project, states: [parent], sourceDigest: source });
  assert.equal(revision.planRevision.parentRunId, parent.runId);
  assert.equal(revision.changeRequest.id, 'CR-1');
  assert.equal(revision.changeRequest.digest, digestJson(project.policy.planChangeRequests['CR-1']));
  const resolution = resolveRunLineage({ plan: planned({ action: 'replan', sourceDigest: source, parent: revision.planRevision }), states: [parent], currentLineage: { revision: 1, activeRunId: parent.runId } });
  assert.equal(resolution.action, 'supersede-and-start');
  assert.equal(resolution.reasonCode, 'PLAN_REVISION_REQUESTED');
  assert.equal(resolveRunLineage({ plan: planned({ action: 'replan', parent: { ...revision.planRevision, parentAuthorityDigest: 'f'.repeat(64) } }), states: [parent] }).action, 'block');
  assert.equal(resolveRunLineage({ plan: planned({ action: 'replan', parent: revision.planRevision }), states: [parent], currentLineage: { revision: 2, activeRunId: 'another-plan' } }).reasonCode, 'REPLAN_PARENT_STALE_OR_BUSY');
  const recovered = { ...reviewed({ approved: false, status: 'superseded' }), runId: 'recovered-plan',
    metadata: { ...parent.metadata, supersededByRunId: 'unstarted-replacement', supersededReason: `development-h3-recovery:${'f'.repeat(64)}` } };
  const afterRecovery = resolveRunLineage({ plan: planned({ action: 'replan', parent: revision.planRevision }),
    states: [parent, recovered], currentLineage: { revision: 2, activeRunId: recovered.runId } });
  assert.equal(afterRecovery.action, 'supersede-and-start');
  assert.equal(afterRecovery.reasonCode, 'PLAN_REVISION_REQUESTED');
  const unverifiedRetirement = { ...recovered, metadata: { ...recovered.metadata, supersededReason: 'replacement-lifecycle-plan' } };
  assert.equal(resolveRunLineage({ plan: planned({ action: 'replan', parent: revision.planRevision }),
    states: [parent, unverifiedRetirement], currentLineage: { revision: 2, activeRunId: unverifiedRetirement.runId } }).reasonCode,
  'REPLAN_PARENT_STALE_OR_BUSY');
  const activeReplacement = { ...reviewed({ approved: false, status: 'running' }), runId: 'unstarted-replacement',
    metadata: { ...parent.metadata, commandIntent: { ...parent.metadata.commandIntent, action: 'replan' } } };
  assert.equal(resolveRunLineage({ plan: planned({ action: 'replan', parent: revision.planRevision }),
    states: [parent, recovered, activeReplacement], currentLineage: { revision: 2, activeRunId: recovered.runId } }).reasonCode,
  'REPLAN_PARENT_STALE_OR_BUSY');
  const unrelated = { ...recovered, metadata: { ...recovered.metadata, logicalTaskKey: 'other-task' } };
  assert.equal(resolveRunLineage({ plan: planned({ action: 'replan', parent: revision.planRevision }),
    states: [parent, unrelated], currentLineage: { revision: 2, activeRunId: unrelated.runId } }).reasonCode, 'REPLAN_PARENT_STALE_OR_BUSY');
  const waiting = reviewed({ approved: true });
  const waitingRevision = preparePlanRevisionIntent({ intent, project, states: [waiting], sourceDigest: source });
  assert.equal(resolveRunLineage({ plan: planned({ action: 'replan', sourceDigest: source, parent: waitingRevision.planRevision }), states: [waiting] }).action, 'supersede-and-start');
  assert.throws(() => preparePlanRevisionIntent({ intent: { ...intent, selector: 'missing' }, project, states: [parent], sourceDigest: source }), error => error.code === 'REPLAN_CHANGE_REQUEST_UNKNOWN');
  assert.throws(() => preparePlanRevisionIntent({ intent: { ...intent, selector: undefined }, project, states: [parent], sourceDigest: source }), error => error.code === 'REPLAN_NO_CHANGE');
  assert.throws(() => preparePlanRevisionIntent({ intent, project, states: [], sourceDigest: source }), error => error.code === 'REPLAN_PARENT_REQUIRED');
});

test('replan captures idle implementation for retirement and blocks an active Lease', () => {
  const parent = reviewed({ approved: true, status: 'closed' });
  const intent = { action: 'replan', target: 'V1', workflowId: 'engine-delivery', profileId: 'engine-delivery', preset: 'default' };
  const implementation = { ...reviewed({ approved: true, status: 'running' }), runId: 'implement-old',
    metadata: { commandIntent: { action: 'implement', target: 'V1' }, workflow: { id: 'engine-delivery' } },
    features: [{ id: 'implement/V1', metadata: { stage: 'implementation' } }], submissions: [] };
  implementation.authorityDigest = digestJson(Object.fromEntries(Object.entries(implementation).filter(([key]) => key !== 'authorityDigest')));
  const revision = preparePlanRevisionIntent({ intent, project: { policy: {} }, states: [parent, implementation], sourceDigest: nextSource });
  assert.deepEqual(revision.planRevision.affectedImplementationRuns.map(run => run.runId), ['implement-old']);
  const live = { ...implementation, leases: [{ status: 'active' }] };
  assert.throws(() => preparePlanRevisionIntent({ intent, project: { policy: {} }, states: [parent, live], sourceDigest: nextSource }), error => error.code === 'REPLAN_IMPLEMENTATION_BUSY');
  const unresolved = { ...implementation, findings: [{ id: 'P2-open', status: 'open' }] };
  assert.throws(() => preparePlanRevisionIntent({ intent, project: { policy: {} }, states: [parent, unresolved], sourceDigest: nextSource }), error => error.code === 'REPLAN_OPEN_FINDINGS');
});

test('revision artifact shows complete feature delta and old approval cannot approve the new plan', () => {
  const parent = reviewed({ approved: true, status: 'closed' });
  const old = planApprovalSnapshot(parent);
  const revisedPlan = { proposedFeatures: [
    { ...currentPlan.proposedFeatures[0], allowedPaths: ['src/view.rs', 'src/mahjong.rs'] },
    { id: 'F05', projectId: 'engine', disposition: 'project-owned', allowedPaths: ['tests'], dependsOn: ['F04'], contracts: [], verification: [] },
  ] };
  assert.deepEqual(diffPlanFeatures(currentPlan, revisedPlan).map(change => change.disposition), ['modified', 'added']);
  assert.deepEqual(diffPlanFeatures(currentPlan, { proposedFeatures: [{ ...currentPlan.proposedFeatures[0], projectId: 'other-project' }] }).map(change => change.disposition), ['removed', 'added']);
  const next = structuredClone(parent);
  next.runId = 'next-plan';
  next.metadata = { ...next.metadata, planRevision: { parentRunId: parent.runId, parentPlanDigest: old.planDigest, parentPlan: currentPlan } };
  next.submissions[0].result.outputs.plan.value = revisedPlan;
  next.decisions = [{ id: 'implementation-plan-approved', actor: 'user', decision: 'approved', projectId: parent.projectId, runId: parent.runId, planDigest: old.planDigest, artifactDigest: old.artifactDigest }];
  const newArtifact = planApprovalSnapshot(next);
  assert.match(newArtifact.markdown, /相对上一版的修订/);
  assert.match(newArtifact.markdown, /modified.*F04/);
  assert.equal(planApprovalSatisfied(next), false);
});
