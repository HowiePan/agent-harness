import { qaPorts } from '../../contracts/index.mjs';
import { node } from '../node.mjs';

export const questionNodes = [
  node('parse', [], { outputPorts: { question: qaPorts.question }, acceptance: ['Parse the exact question revision and identify answer scope.'] }),
];
