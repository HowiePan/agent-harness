import { qaPorts } from '../../contracts/index.mjs';
import { node, qaTask } from '../node.mjs';

export const answerNodes = [
  node('answer', [], {
    outputPorts: { answer: qaPorts.answer }, outputChecks: [{ portId: 'answer', path: 'claim', operator: 'non-empty' }, { portId: 'answer', path: 'evidence', operator: 'non-empty' }],
    task: qaTask({
      role: { id: 'answer-author', description: 'Produces the final answer strictly from an authorized memory match or searched evidence.' },
      objective: 'Answer the exact parsed question clearly, completely, and only to the degree supported by current evidence.',
      instructions: ['Consume the typed evidence available on the selected branch.', 'State the supported answer and its material limitations.', 'Attach non-empty evidence and a stable claim fingerprint.'],
      steps: [{ id: 'synthesize', instruction: 'Synthesize the narrowest complete answer supported by evidence.' }, { id: 'verify-claim', instruction: 'Check the claim against evidence, scope, and rejected-answer records.' }],
      acceptance: ['The answer directly addresses the exact question.', 'Every material claim has non-empty current evidence.', 'The qa-answer-v1 output does not repeat a rejected claim.'],
    }),
  }),
];
export const clarificationNodes = [
  node('clarify', [], {
    outputPorts: { clarification: qaPorts.clarification }, outputChecks: [{ portId: 'clarification', path: 'question', operator: 'non-empty' }],
    task: qaTask({
      role: { id: 'clarification-author', description: 'Requests the smallest user clarification needed to resolve an evidence or scope gap.' },
      objective: 'Explain the exact missing evidence or ambiguity and ask one precise, answerable clarification question.',
      instructions: ['Consume the typed insufficient-evidence candidate.', 'Identify the single highest-impact missing fact or scope choice.', 'Ask one concise question without presenting an unsupported answer.'],
      steps: [{ id: 'identify-gap', instruction: 'Identify the exact evidence or scope gap blocking an answer.' }, { id: 'ask', instruction: 'Formulate one precise clarification question.' }],
      acceptance: ['The missing evidence or ambiguity is stated concretely.', 'Exactly one question is asked and answering it would unblock progress.', 'The qa-clarification-v1 output contains no unsupported answer.'],
    }),
  }),
];
