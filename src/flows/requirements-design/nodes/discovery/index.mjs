import { requirementsPorts } from '../../contracts/index.mjs';
import { node } from '../node.mjs';

export const discoveryNodes = [
  node('search', ['normalize'], { forEach: 'repositories', sourceType: 'repository', outputPorts: { code: requirementsPorts.code }, acceptance: ['Search the pinned repository and cite exact files, symbols, and source digests.'] }),
  node('map', ['search'], { outputPorts: { impact: requirementsPorts.impact }, acceptance: ['Map every requirement to code evidence, missing behavior, and cross repository effects.'] }),
];
