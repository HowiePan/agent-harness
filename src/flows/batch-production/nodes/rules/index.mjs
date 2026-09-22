import { batchNode, batchTask } from '../node.mjs';

export const rulesNode = batchNode('rules', 'rules', [], {
  task: batchTask({
    role: { id: 'rule-analyst', description: 'Verifies the complete rule set governing one batch item.' },
    objective: 'Establish whether the assigned item has a complete, internally consistent, and executable rule contract.',
    instructions: ['Inspect the item specification and authoritative rule sources.', 'Identify missing, conflicting, ambiguous, or untestable rules.', 'Mark readiness only from evidence.'],
    steps: [{ id: 'inspect-rules', instruction: 'Inspect every rule and its authoritative source.' }, { id: 'resolve-readiness', instruction: 'Determine readiness and record exact blockers.' }],
    acceptance: ['Every applicable rule is accounted for.', 'Conflicts and ambiguities are explicit.', 'The batch-rules-v1 output sets ready=true only when production may safely start.'],
  }),
});

export const rulesNodes = [rulesNode];
