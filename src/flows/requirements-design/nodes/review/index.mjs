import { requirementsPorts } from '../../contracts/index.mjs';
import { node, requirementsTask } from '../node.mjs';

export const reviewNodes = [
  node('review', ['requirements-doc', 'design-doc'], {
    readAllSources: true,
    outputPorts: { review: requirementsPorts.review, knowledge: requirementsPorts.knowledge },
    outputChecks: [{ portId: 'review', path: 'passed', operator: 'equals', value: true }, { portId: 'review', path: 'documents', operator: 'non-empty' }],
    task: requirementsTask({
      role: { id: 'requirements-reviewer', description: 'Independently verifies both generated documents against all pinned sources.' },
      objective: 'Determine whether the requirements and design documents are complete, accurate, mutually consistent, and fully traceable.',
      instructions: ['Consume both typed document references.', 'Read every pinned source relevant to the analysis.', 'Report all P0-P3 findings and propose only evidence-backed reusable knowledge candidates.'],
      inputs: [{ id: 'source-ids', source: 'feature', path: 'sourceIds', required: true, description: 'All pinned sources that must be covered by the review.' }],
      steps: [{ id: 'cross-check', instruction: 'Cross-check both documents against every pinned source and typed upstream result.' }, { id: 'findings', instruction: 'Report every P0-P3 defect, omission, contradiction, and unsupported claim.' }, { id: 'knowledge', instruction: 'Propose reusable knowledge only when its dependencies and evidence are explicit.' }],
      constraints: ['Remain read-only during independent review.', 'Do not promote a memory candidate to verified knowledge.'],
      acceptance: ['Both documents are reviewed against every pinned source.', 'All findings and gap-alignment issues are reported with evidence.', 'document-review-v1 passes only when clean, and memory-candidates-v1 contains only traceable candidates.'],
    }),
  }),
];
