import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlannedLifecycleEvent, createPreflightLifecycleEvent } from '../integrations/codex/agent-harness-codex/lib/visible-lifecycle-events.mjs';

test('visible lifecycle progress stays bounded before native Host requests', () => {
  const plan = {
    planDigest: 'a'.repeat(64),
    logicalTaskKey: 'b'.repeat(64),
    project: { id: 'project' },
    workspaceRef: { workspaceId: 'workspace' },
    workflow: { id: 'workflow' },
    intent: { action: 'quality', target: 'V3.8.4' },
    run: {
      runId: 'run',
      features: Array.from({ length: 100 }, (_, index) => ({ id: `feature-${index}`, details: 'must-not-be-rendered'.repeat(100) })),
      sourceDigest: 'c'.repeat(64),
      runtimePluginId: 'codex-conversation-runtime',
      agentExecutionMode: 'conversation-visible',
    },
    stopCondition: { type: 'run-ready-to-close' },
  };
  const event = createPlannedLifecycleEvent({ commandId: 'command', intentDigest: 'd'.repeat(64), plan });
  const rendered = JSON.stringify(event);
  assert(rendered.length < 4096);
  assert.equal(event.planDigest, plan.planDigest);
  assert.equal(event.summary.featureCount, 100);
  assert(!rendered.includes('must-not-be-rendered'));
  assert(!rendered.includes('feature-99'));
});

test('visible lifecycle preflight exposes blocker identities without dumping report details', () => {
  const report = {
    executionReady: false,
    reportDigest: 'e'.repeat(64),
    expiresAt: '2026-09-21T00:01:00.000Z',
    checks: [{
      id: 'visible-host-contract',
      ready: false,
      details: { diagnostic: 'must-not-be-rendered'.repeat(1000) },
      issues: [{ code: 'CODEX_HOST_HOOK_RESPONSE_TIMEOUT', message: 'No verified PostToolUse result reached the pending Host request before timeout. '.repeat(100), details: { raw: 'must-not-be-rendered' } }],
    }],
    writeProbe: { attempted: false, ready: false, cleaned: true },
    lineageResolution: { action: 'block', reasonCode: 'HOST_NOT_READY', candidates: Array.from({ length: 100 }, (_, index) => `candidate-${index}`) },
  };
  const event = createPreflightLifecycleEvent({ commandId: 'command', intentDigest: 'f'.repeat(64), planDigest: 'a'.repeat(64), report });
  const rendered = JSON.stringify(event);
  assert(rendered.length < 4096);
  assert.equal(event.executionReady, false);
  assert.equal(event.checks[0].issues[0].code, 'CODEX_HOST_HOOK_RESPONSE_TIMEOUT');
  assert(!rendered.includes('must-not-be-rendered'));
  assert(!rendered.includes('candidate-99'));
});
