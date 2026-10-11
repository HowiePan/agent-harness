import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyPlanningPredecessor } from '../src/application/version-predecessor-gate.mjs';

const project = { id: 'engine', policy: { versionPredecessors: { 'V3.9.0': 'V3.8.5' } } };
const intent = action => ({ action, target: 'V3.9.0' });

test('requirements, plan, and replan require the declared predecessor to be Git-published', async () => {
  const calls = [];
  const readVersionRelease = async (id, target) => {
    calls.push([id, target]);
    return { state: { status: 'released', publication: { ref: 'harness/engine/V3.8.5' } }, formalReleaseStatus: 'git-published' };
  };
  for (const action of ['requirements', 'plan', 'replan']) {
    const verified = await verifyPlanningPredecessor({ project, intent: intent(action), readVersionRelease });
    assert.equal(verified.predecessor, 'V3.8.5');
  }
  assert.deepEqual(calls, Array(3).fill(['engine', 'V3.8.5']));
});

test('planning fails closed on missing lineage, incomplete release, or local-only approval', async () => {
  const readVersionRelease = async () => ({ state: { status: 'released' }, formalReleaseStatus: 'approval-recorded-local-only' });
  await assert.rejects(verifyPlanningPredecessor({ project: { id: 'engine', policy: { versionPredecessors: {} } }, intent: intent('plan'), readVersionRelease }),
    error => error.code === 'PLANNING_PREDECESSOR_UNDECLARED');
  await assert.rejects(verifyPlanningPredecessor({ project: { id: 'engine', policy: { versionPredecessors: { 'V3.9.0': 'V3.10.0' } } }, intent: intent('plan'), readVersionRelease }),
    error => error.code === 'PLANNING_PREDECESSOR_UNDECLARED');
  await assert.rejects(verifyPlanningPredecessor({ project, intent: intent('requirements'), readVersionRelease }),
    error => error.code === 'PLANNING_PREDECESSOR_NOT_RELEASED');
  assert.equal(await verifyPlanningPredecessor({ project, intent: intent('implement'), readVersionRelease }), null);
});
