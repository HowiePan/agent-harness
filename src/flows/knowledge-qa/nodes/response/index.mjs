import { qaPorts } from '../../contracts/index.mjs';
import { node } from '../node.mjs';

export const answerNodes = [
  node('answer', [], { outputPorts: { answer: qaPorts.answer }, outputChecks: [{ portId: 'answer', path: 'claim', operator: 'non-empty' }, { portId: 'answer', path: 'evidence', operator: 'non-empty' }], acceptance: ['Return an evidence backed answer; do not repeat rejected claims.'] }),
];
export const clarificationNodes = [
  node('clarify', [], { outputPorts: { clarification: qaPorts.clarification }, outputChecks: [{ portId: 'clarification', path: 'question', operator: 'non-empty' }], acceptance: ['State what evidence is missing and ask the user one precise clarification question.'] }),
];
