import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveRunLineage } from '../src/application/lineage.mjs';
import { planApprovalSnapshot } from '../src/flows/delivery-lifecycle/plan-approval.mjs';

const now = '2026-10-13T12:00:00.000Z';
const plan = {
  project: { id: 'project' }, logicalTaskKey: 'a'.repeat(64), planDigest: 'b'.repeat(64),
  intent: { action: 'implement', target: 'v1', workflowId: 'delivery', profileId: 'delivery' },
  run: { runId: 'new-implementation', profileId: 'delivery', sourceDigest: 'c'.repeat(64), agentExecutionMode: 'conversation-visible' },
};
const terminalRun = status => ({
  projectId: 'project', runId: `old-${status}`, revision: 9, authorityDigest: 'd'.repeat(64),
  status, profile: { id: 'delivery' }, sourceDigest: 'e'.repeat(64), updatedAt: now,
  leases: [], dispatches: [], metadata: { logicalTaskKey: plan.logicalTaskKey, lifecyclePlanDigest: 'f'.repeat(64) },
});
const reviewedRevision = (prior, { approved = true } = {}) => {
  const state = {
    projectId: 'project', runId: 'reviewed-revision', status: 'closed', profile: { id: 'delivery' },
    sourceDigest: plan.run.sourceDigest, leases: [], dispatches: [],
    metadata: {
      logicalTaskKey: '0'.repeat(64), commandIntent: { ...plan.intent, action: 'replan' },
      planRevision: { affectedImplementationRuns: prior.map(({ runId, revision, authorityDigest }) => ({ runId, revision, authorityDigest })) },
    },
    features: [{ id: 'plan', state: 'completed', metadata: { stage: 'version-planning' } },
      { id: 'review', state: 'completed', metadata: { stage: 'plan-review' } }],
    submissions: [{ featureId: 'plan', result: { status: 'completed', outputs: { plan: { value: { proposedFeatures: [] } } } } },
      { featureId: 'review', result: { status: 'completed', outputs: { 'plan-review': { value: { approved: true, findings: [] } } } } }],
    decisions: [],
  };
  const snapshot = planApprovalSnapshot(state);
  if (approved) state.decisions.push({ id: 'implementation-plan-approved', actor: 'user', decision: 'approved',
    projectId: state.projectId, runId: state.runId, planDigest: snapshot.planDigest, artifactDigest: snapshot.artifactDigest });
  return state;
};
const resolve = (prior, revision, policy = {}) => resolveRunLineage({ plan, states: [...prior, revision], policy, now: () => now });

test('approved Replan starts a fresh implementation and keeps all terminal outcomes in its audit candidates', () => {
  const prior = [terminalRun('failed'), terminalRun('incomplete')];
  const resolution = resolve(prior, reviewedRevision(prior));
  assert.equal(resolution.action, 'start');
  assert.equal(resolution.reasonCode, 'APPROVED_REPLAN_REPLACES_TERMINAL_IMPLEMENTATION');
  assert.equal(resolution.selectedRunId, plan.run.runId);
  assert.deepEqual(resolution.candidates.map(candidate => candidate.status), ['failed', 'incomplete']);
  assert.deepEqual(resolution.expectedRevisions, { 'old-failed': 9, 'old-incomplete': 9 });
  assert.equal(resolve(prior, reviewedRevision(prior), { automaticLineageResolution: false }).reasonCode, 'AUTOMATIC_LINEAGE_POLICY_DENIED');
});

test('terminal implementation cannot restart without a matching approved revision', () => {
  const prior = [terminalRun('failed')];
  const mutations = [
    revision => { revision.decisions = []; },
    revision => { revision.decisions[0].artifactDigest = '0'.repeat(64); },
    revision => { revision.status = 'ready'; },
    revision => { revision.metadata.commandIntent.workflowId = 'other'; },
    revision => { revision.metadata.commandIntent.target = 'v2'; },
    revision => { revision.projectId = 'other'; },
    revision => { revision.profile.id = 'other'; },
    revision => { revision.metadata.planRevision.affectedImplementationRuns = []; },
    revision => { revision.metadata.planRevision.affectedImplementationRuns[0].revision++; },
    revision => { revision.metadata.planRevision.affectedImplementationRuns[0].authorityDigest = '0'.repeat(64); },
  ];
  for (const mutate of mutations) {
    const revision = reviewedRevision(prior);
    mutate(revision);
    assert.equal(resolve(prior, revision).reasonCode, 'EXISTING_RUN_REQUIRES_INTERNAL_CONTINUATION');
  }
  const resolution = resolveRunLineage({ plan, states: prior, now: () => now });
  assert.equal(resolution.action, 'block');
});

test('a revision cannot replace unfinished work, live or expired transport, or resume the exact failed Plan', () => {
  const prior = [terminalRun('failed')];
  const revision = reviewedRevision(prior);
  const running = { ...prior[0], status: 'running' };
  assert.equal(resolve([running], revision).reasonCode, 'EXISTING_RUN_REQUIRES_INTERNAL_CONTINUATION');
  const assigned = { ...prior[0], dispatches: [{ dispatchId: 'old-dispatch', status: 'assigned' }] };
  assert.equal(resolve([assigned], revision).action, 'block');
  for (const lastHeartbeatAt of [now, '2026-10-13T11:00:00.000Z']) {
    const active = { ...prior[0], leases: [{ leaseId: 'old-lease', featureId: 'feature', status: 'active', lastHeartbeatAt, heartbeatTimeoutMs: 120000 }] };
    assert.equal(resolve([active], revision).action, 'block');
  }
  const exactPlan = { ...plan, planDigest: prior[0].metadata.lifecyclePlanDigest, run: { ...plan.run, runId: prior[0].runId } };
  assert.equal(resolveRunLineage({ plan: exactPlan, states: [...prior, revision], now: () => now }).reasonCode, 'TERMINAL_RUN_REQUIRES_NEW_PLAN');
});
