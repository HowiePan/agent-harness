import assert from 'node:assert/strict';
import test from 'node:test';
import { decideInterruption } from '../src/application/interruption-policy.mjs';

const problem = { logicalRoot: 'owner', sourceDigest: 'source', contractDigest: 'contract', summary: 'Unknown failure.' };
const diagnostic = { id: 'read-only', operation: 'diagnose', available: true, authorized: true, evidenceBound: true, readOnly: true };
const repair = { id: 'local-repair', operation: 'repair', available: true, authorized: true, evidenceBound: true };
const decide = overrides => decideInterruption({ problem, facts: { identityTrusted: true }, capabilities: [diagnostic], ...overrides });

test('new failure labels and capacity estimates require diagnosis rather than automatic Amend or write authority', () => {
  for (const label of ['capacity-mismatch', 'permission-denied', 'external-blocker', 'P0', 'unknown-future-failure']) {
    const decision = decide({ problem: { ...problem, summary: label } });
    assert.equal(decision.action, 'diagnose'); assert.equal(decision.requiredDecision, null);
    assert.equal(decision.boundary, 'action');
  }
});

test('verified hard boundaries isolate writes while preserving independently authorized read-only diagnostics', () => {
  for (const fact of ['authorizationRequired', 'contractChangeVerified', 'integrityRisk']) {
    const decision = decide({ facts: { [fact]: true }, capabilities: [repair, diagnostic] });
    assert.equal(decision.action, 'diagnose'); assert.equal(decision.capabilityId, 'read-only');
    const stopped = decide({ facts: { [fact]: true }, capabilities: [repair] });
    assert.equal(stopped.action, 'stop'); assert.equal(stopped.boundary, 'workflow'); assert(stopped.requiredDecision);
  }
  assert.equal(decide({ facts: { identityTrusted: false }, capabilities: [repair, diagnostic] }).action, 'diagnose');
  for (const facts of [{ userStopped: true }, { budgetExhausted: true }]) {
    assert.equal(decide({ facts, capabilities: [repair, diagnostic] }).action, 'stop');
  }
});

test('scope, capability and evidence checks apply before repairs; bounded known repairs precede diagnostic work', () => {
  assert.equal(decide({ capabilities: [repair, diagnostic] }).action, 'repair');
  for (const field of ['available', 'authorized', 'evidenceBound']) {
    assert.equal(decide({ capabilities: [{ ...repair, [field]: false }, diagnostic] }).action, 'diagnose');
  }
  assert.equal(decide({ capabilities: [] }).category, 'capability');
});

test('same root/source/contract cannot get free reviews by relabeling errors; root total and verified wait deadlines are finite', () => {
  const first = decide();
  const history = [{ id: 'one', logicalRoot: 'owner', fingerprint: first.fingerprint }];
  assert.equal(decide({ problem: { ...problem, summary: 'different error name' }, history }).category, 'no-progress');
  assert.equal(decide({ problem: { ...problem, sourceDigest: 'new-source' }, history }).action, 'diagnose');
  assert.equal(decide({ history: [...history, { id: 'two', logicalRoot: 'owner', fingerprint: 'another' }] }).category, 'recovery-budget');
  const wait = { ...diagnostic, id: 'wait', operation: 'wait' };
  assert.equal(decide({ facts: { waitSignalVerified: true, waitDeadlineValid: true }, capabilities: [wait] }).action, 'wait');
  assert.equal(decide({ facts: { waitSignalVerified: true, waitDeadlineValid: false }, capabilities: [wait] }).action, 'stop');
});
