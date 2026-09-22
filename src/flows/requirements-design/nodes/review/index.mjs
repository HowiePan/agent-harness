import { requirementsPorts } from '../../contracts/index.mjs';
import { node } from '../node.mjs';

export const reviewNodes = [
  node('review', ['requirements-doc', 'design-doc'], {
    readAllSources: true,
    outputPorts: { review: requirementsPorts.review, knowledge: requirementsPorts.knowledge },
    outputChecks: [{ portId: 'review', path: 'passed', operator: 'equals', value: true }, { portId: 'review', path: 'documents', operator: 'non-empty' }],
    acceptance: ['Independently verify both documents against every pinned source, report all P0-P3 findings, verify PBI/code gap alignment, and propose evidence backed reusable knowledge candidates.'],
  }),
];
