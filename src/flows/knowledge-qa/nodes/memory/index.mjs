import { qaPorts } from '../../contracts/index.mjs';
import { node } from '../node.mjs';

export const memoryNodes = [
  node('lookup', ['parse'], { outputPorts: { match: qaPorts.match }, acceptance: ['Compare the pinned, valid memory snapshot to the question; report the exact match result.'] }),
];
