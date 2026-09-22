import { requirementsPorts } from '../../contracts/index.mjs';
import { node, requirementsTask } from '../node.mjs';

export const intakeNodes = [
  node('ingest', [], {
    forEach: 'documents', sourceType: 'document', outputPorts: { facts: requirementsPorts.facts },
    task: requirementsTask({
      role: { id: 'requirement-extractor', description: 'Extracts facts from one pinned requirement document without interpretation drift.' },
      objective: 'Extract every requirement, constraint, ambiguity, and source location from the assigned document.',
      instructions: ['Read only the assigned pinned document.', 'Separate explicit statements from implications and unresolved ambiguity.', 'Preserve exact source locations and wording significance.'],
      inputs: [{ id: 'source-ids', source: 'feature', path: 'sourceIds', required: true, description: 'The exact pinned document source assigned to this Feature.' }],
      steps: [{ id: 'read', instruction: 'Read the complete assigned document through the pinned source tool.' }, { id: 'extract', instruction: 'Extract requirements and ambiguities with exact source locations.' }],
      acceptance: ['Every material requirement and ambiguity in the assigned document is represented.', 'No unsupported requirement is introduced.', 'The source-facts-v1 output binds facts to the exact source ID.'],
    }),
  }),
  node('normalize', ['ingest'], {
    outputPorts: { requirements: requirementsPorts.requirements },
    task: requirementsTask({
      role: { id: 'requirement-normalizer', description: 'Combines typed document facts into one traceable requirement set.' },
      objective: 'Produce a complete, deduplicated requirement model while preserving conflicts and source traceability.',
      instructions: ['Consume every typed ingest output.', 'Merge equivalent facts without losing source references.', 'Expose conflicts, gaps, and unresolved terminology.'],
      steps: [{ id: 'merge', instruction: 'Merge and deduplicate source facts.' }, { id: 'reconcile', instruction: 'Identify conflicts and unresolved requirements.' }],
      acceptance: ['Every input fact is mapped into the normalized model.', 'Conflicts and gaps remain explicit.', 'The requirements-v1 output is complete and traceable.'],
    }),
  }),
];
