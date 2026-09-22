import { requirementsPorts } from '../../contracts/index.mjs';
import { node } from '../node.mjs';

export const discoveryNodes = [
  node('search', ['normalize'], {
    forEach: 'repositories',
    sourceType: 'repository',
    outputPorts: { code: requirementsPorts.code },
    acceptance: ['Search the pinned repository and cite exact files, symbols, and source digests, identifying both code implementing requirements and independent capabilities.'],
  }),
  node('map', ['search'], {
    outputPorts: { impact: requirementsPorts.impact },
    acceptance: ['Map every requirement to code evidence, missing behavior, undocumented code features, and cross repository effects.'],
  }),
];

export const codeDiscoveryNodes = [
  node('search', [], {
    forEach: 'repositories',
    sourceType: 'repository',
    outputPorts: { code: requirementsPorts.code },
    acceptance: ['Search the pinned repository, index directory structures, component trees, and functional modules with cited source files.'],
  }),
  node('map', ['search'], {
    outputPorts: { impact: requirementsPorts.impact },
    acceptance: ['Map codebase architecture, module directory structure, functional capabilities, and feature-to-directory mappings.'],
  }),
];
