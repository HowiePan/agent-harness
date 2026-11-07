import assert from 'node:assert/strict';
import test from 'node:test';
import { coordinationRecoveryDirective } from '../src/application/coordination-recovery.mjs';
import { describeInterruptionError } from '../src/application/interruption-outcome.mjs';

test('process errors retain the user goal and require diagnosis or independent maintenance, never arbitrary process replay', () => {
  const error = describeInterruptionError({ code: 'UNSEEN_RECOMMENDATION_ERROR', message: 'A recommendation needs correction.' });
  assert.equal(error.coordination.userGoalComplete, false);
  assert.equal(error.coordination.userInputRequired, false);
  assert.equal(error.coordination.nextAction, 'diagnose-origin-and-preserve-goal');
  const maintenance = coordinationRecoveryDirective({ incident: { origin: 'harness' }, commandId: 'exact-command', intentDigest: 'sealed-intent', runId: 'original-run' });
  assert.equal(maintenance.nextAction, 'independent-maintenance-then-formal-recovery');
  assert.equal(maintenance.processReplayAllowed, false);
  assert.equal(maintenance.userInputRequired, false);
  assert.equal(maintenance.binding.runId, 'original-run');
});

test('user stop and necessary approval or exhausted allowances preserve their human boundary; only lifecycle completion closes the goal', () => {
  for (const category of ['authorization', 'contract', 'budget', 'recovery-budget']) {
    const directive = coordinationRecoveryDirective({ interruption: { category, requiredDecision: 'exact-decision' } });
    assert.equal(directive.userGoalComplete, false);
    assert.equal(directive.userInputRequired, true);
    assert.equal(directive.requiredDecision, 'exact-decision');
  }
  assert.equal(coordinationRecoveryDirective({ interruption: { category: 'user-stop' } }).nextAction, 'preserve-and-stop');
  assert.equal(coordinationRecoveryDirective({ status: 'closed' }).userGoalComplete, true);
  assert.equal(coordinationRecoveryDirective({ status: 'attention-required' }).userGoalComplete, false);
});

test('missing current command and exhausted command recovery never recommend independent automatic restart',()=>{
  for(const code of ['CURRENT_USER_COMMAND_REQUIRED','USER_COMMAND_ALREADY_CONSUMED','COMMAND_RECOVERY_EXHAUSTED']){
    const outcome=describeInterruptionError({code,message:'Preserve current command boundary.'});
    assert.equal(outcome.action,'stop');assert.equal(outcome.coordination.userInputRequired,true);
    assert.equal(outcome.coordination.processReplayAllowed,false);
    assert(outcome.coordination.constraints.every(line=>!line.includes('no new user command is needed')));
  }
});
