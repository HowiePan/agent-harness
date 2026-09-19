import { qaPorts } from '../../contracts/index.mjs';
import { node } from '../node.mjs';

export const discoveryNodes = [
  node('search', [], { sourceType: 'repository', outputPorts: { candidate: qaPorts.candidate }, acceptance: ['Search pinned code and documents; cite exact source paths and digests for the answer candidate.'] }),
];
