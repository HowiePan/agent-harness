import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyLocalIncident } from '../src/application/local-incident.mjs';
import { visibleLifecycleStopReason } from '../src/application/lifecycle-execution-service.mjs';

test('source-linked Host failures classify identically across Workflow actions', () => {
  for (const [workflowId, action, target] of [
    ['engine-delivery', 'quality', 'V3.8.4'],
    ['batch-production', 'produce', 'B1'],
    ['requirements-design', 'requirements', 'R1'],
    ['knowledge-qa', 'answer', 'Q1'],
  ]) {
    const incident = classifyLocalIncident({ error: { code: 'CODEX_ROLLOUT_TOOL_METADATA_MISMATCH', details: { containment: { disposition: 'interrupted' } } }, phase: 'execution', projectId: 'fixture', workflowId, action, target, runId: 'run-1' });
    assert.equal(incident.severity, 'P1');
    assert.equal(incident.patchLevelHint, 'H3');
    assert.equal(incident.currentExecution, 'contained');
    assert.equal(incident.disposition, 'contain-effect-and-repair-in-harness-maintenance');
    assert.equal(incident.target, target);
    assert.equal(incident.workflowId, workflowId);
  }
});

test('local incident classification separates patch impact, Authority integrity, and project Gates', () => {
  const h4 = classifyLocalIncident({ error: 'DEVELOPMENT_PATCH_INCOMPATIBLE', phase: 'source-sync' });
  assert.equal(h4.patchLevelHint, 'H4');
  assert.equal(h4.severity, 'P2');
  assert.equal(h4.continuation, 'review-migration-or-release-plan');
  const authority = classifyLocalIncident({ error: 'AUTHORITY_DIGEST_MISMATCH', phase: 'execution' });
  assert.equal(authority.severity, 'P0');
  assert.equal(authority.patchLevelHint, 'H4');
  const gate = classifyLocalIncident({ error: 'final-gates-not-passed', phase: 'execution' });
  assert.equal(gate.origin, 'project');
  assert.equal(gate.severity, 'P2');
  assert.equal(gate.disposition, 'resolve-project-gates');
  const unknown = classifyLocalIncident({ error: {}, phase: 'execution' });
  assert.equal(unknown.severityStatus, 'provisional');
  assert.equal(unknown.origin, 'undetermined');
  assert.equal(unknown.maintenanceContext, null);
  const environment = classifyLocalIncident({ error: 'LOCAL_PROCESS_GATE_HOST_UNAVAILABLE', phase: 'preflight' });
  assert.equal(environment.origin, 'environment');
  assert.equal(environment.severity, 'P2');
  assert.equal(environment.continuation, 'retry-preflight-with-captured-process-capability');
  const sourceDrift = classifyLocalIncident({ error: 'IMPLEMENTATION_PLAN_SOURCE_MISMATCH', phase: 'start' });
  assert.equal(sourceDrift.origin, 'project');
  assert.equal(sourceDrift.severity, 'P2');
  assert.equal(sourceDrift.disposition, 'review-exact-plan-source-delta');
  assert.equal(sourceDrift.continuation, 'record-exact-source-compatibility-or-replan');
});

test('a blocked dependency chain reports a project blocker instead of a ready Harness incident', () => {
  const state = { status: 'ready', features: [{ state: 'blocked' }, { state: 'pending' }] };
  const reason = visibleLifecycleStopReason(state);
  assert.equal(reason, 'blocked-dependencies');
  assert.equal(visibleLifecycleStopReason({ status: 'all-remaining-blocked', features: [{ state: 'blocked' }] }), 'all-remaining-blocked');
  for (const code of [reason, 'all-remaining-blocked']) {
    const incident = classifyLocalIncident({ error: code, phase: 'execution' });
    assert.equal(incident.origin, 'project');
    assert.equal(incident.severity, 'P2');
    assert.equal(incident.severityStatus, 'classified');
    assert.equal(incident.disposition, 'resolve-feature-blockers');
    assert.equal(incident.continuation, 'inspect-feature-blockers-then-resume');
  }
});
