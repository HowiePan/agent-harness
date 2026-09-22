import { requirementsPorts } from '../../contracts/index.mjs';
import { node } from '../node.mjs';

export const documentNodes = [
  node('requirements-doc', ['map'], {
    outputKey: 'requirements',
    outputPorts: { document: requirementsPorts.document },
    outputChecks: [{ portId: 'document', path: 'path', operator: 'output-path' }],
    acceptance: ['Write a complete requirements and functional details document with evidence links, documenting specified requirements, code-discovered capabilities, and gap analysis.'],
  }),
  node('design-doc', ['map'], {
    outputKey: 'design',
    outputPorts: { document: requirementsPorts.document },
    outputChecks: [{ portId: 'document', path: 'path', operator: 'output-path' }],
    acceptance: ['Write an implementation design document covering interfaces, data flow, risks, and feature-to-directory mappings.'],
  }),
];
