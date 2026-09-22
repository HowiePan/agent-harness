import { qaPorts } from '../../contracts/index.mjs';
import { node, qaTask } from '../node.mjs';

export const memoryNodes = [
  node('lookup', ['parse'], {
    outputPorts: { match: qaPorts.match },
    task: qaTask({
      role: { id: 'memory-analyst', description: 'Evaluates authorized memory candidates against the parsed question and current source coverage.' },
      objective: 'Determine whether a current, verified, non-rejected memory record can support the exact question.',
      instructions: ['Consume the typed parsed question.', 'Compare it with the pinned memory snapshot and source dependencies.', 'Reject stale, cross-scope, unverified, or negatively marked candidates.'],
      inputs: [{ id: 'memory-snapshot', source: 'memory', path: '$', required: false, description: 'The pinned authorized memory candidates for this workflow instance.' }],
      steps: [{ id: 'filter', instruction: 'Filter memory by scope, verification, validity, dependencies, and negative records.' }, { id: 'match', instruction: 'Determine whether an exact evidence-capable match exists.' }],
      acceptance: ['Only current, authorized, verified, non-rejected memory may count as a hit.', 'The match decision is traceable to the parsed question and source coverage.', 'The memory-match-v1 output reports the exact hit state.'],
    }),
  }),
];
