import { digestJson } from '../common/canonical.mjs';

/** A process exit is not a completed user goal or a new execution grant. */
export const coordinationRecoveryDirective = ({ status = 'error', interruption = null, incident = null,
  commandId = null, intentDigest = null, planDigest = null, runId = null } = {}) => {
  const category = interruption?.category ?? null;
  const complete = ['closed', 'completed'].includes(status);
  const userStop = category === 'user-stop';
  const needsDecision = ['authorization', 'contract', 'budget', 'recovery-budget'].includes(category);
  const body = { version: 'coordination-recovery/1',
    binding: { commandId, intentDigest, planDigest, runId }, userGoalComplete: complete,
    userInputRequired: !complete && (userStop || needsDecision), processReplayAllowed: false,
    nextAction: complete ? 'return-completed' : userStop ? 'preserve-and-stop'
      : needsDecision ? 'prepare-minimum-user-decision'
        : incident?.origin === 'harness' ? 'independent-maintenance-then-formal-recovery' : 'diagnose-origin-and-preserve-goal',
    constraints: complete ? [] : ['Preserve original goal, source, approved contract, diagnostic results and all counters.',
      'Contain unresolved Host effects before another dispatch; never wait for an Agent that was not started.',
      'Diagnose using existing authority. Confirmed Harness defects require independent maintenance, verification and H0-H4 classification.',
      'Use only verified recovery receipts; do not mint an intent, replay an exited Coordinator, rewrite results or edit Authority.',
      'If a new Hook command is truly required, finish repair and recovery preparation before requesting that single minimum action.'],
    requiredDecision: !complete && needsDecision ? interruption.requiredDecision : null,
  };
  return { ...body, directiveDigest: digestJson(body) };
};
