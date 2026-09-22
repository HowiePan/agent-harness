import { qaPorts } from '../../contracts/index.mjs';
import { node, qaTask } from '../node.mjs';

export const questionNodes = [
  node('parse', [], {
    outputPorts: { question: qaPorts.question },
    task: qaTask({
      role: { id: 'question-analyst', description: 'Parses the exact user question revision without answering it prematurely.' },
      objective: 'Produce an unambiguous, scoped representation of the current question revision.',
      instructions: ['Read the exact question and revision from the approved workflow input.', 'Identify requested facts, scope, entities, time boundaries, and ambiguity.', 'Do not answer or expand the requested scope.'],
      inputs: [{ id: 'question-revision', source: 'intent', path: 'workflowInput.questionRevision', required: true, description: 'The exact immutable question revision for this Run.' }],
      steps: [{ id: 'parse-question', instruction: 'Parse the exact question and its explicit boundaries.' }, { id: 'identify-ambiguity', instruction: 'Record ambiguity that affects evidence retrieval or answer correctness.' }],
      acceptance: ['The parsed question preserves the user request and revision exactly.', 'Answer scope and material ambiguity are explicit.', 'The question-v1 output is complete and does not contain an answer.'],
    }),
  }),
];
