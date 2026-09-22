import { requirementsPorts } from '../../contracts/index.mjs';
import { node, requirementsTask } from '../node.mjs';

export const documentNodes = [
  node('requirements-doc', ['map'], {
    outputKey: 'requirements',
    outputPorts: { document: requirementsPorts.document },
    outputChecks: [{ portId: 'document', path: 'path', operator: 'output-path' }],
    task: requirementsTask({
      role: { id: 'requirements-writer', description: 'Writes the authoritative requirements and functional-details document from typed analysis results.' },
      objective: 'Create a complete requirements document that distinguishes specified requirements, observed capabilities, conflicts, and gaps.',
      instructions: ['Consume the typed impact or architecture map.', 'Write to the exact authorized output path.', 'Preserve evidence links and distinguish requirements from code-discovered behavior.'],
      inputs: [{ id: 'output-path', source: 'feature', path: 'outputPath', required: true, description: 'The exact authorized requirements document output path.' }],
      steps: [{ id: 'structure', instruction: 'Organize requirements, capabilities, conflicts, and gaps into a traceable structure.' }, { id: 'write', instruction: 'Write the complete document with evidence links.' }, { id: 'verify-document', instruction: 'Verify coverage and the exact output path.' }],
      acceptance: ['All analyzed requirements and material capabilities are represented with their status.', 'Conflicts and gaps are explicit and evidence-linked.', 'The document-ref-v1 output identifies the exact written document and digest.'],
    }),
  }),
  node('design-doc', ['map'], {
    outputKey: 'design',
    outputPorts: { document: requirementsPorts.document },
    outputChecks: [{ portId: 'document', path: 'path', operator: 'output-path' }],
    task: requirementsTask({
      role: { id: 'design-writer', description: 'Writes an implementation design grounded in typed impact or architecture evidence.' },
      objective: 'Create a complete implementation design covering boundaries, interfaces, data flow, risks, sequencing, and feature-to-directory mappings.',
      instructions: ['Consume the typed impact or architecture map.', 'Write to the exact authorized output path.', 'Tie design decisions and open risks to source evidence.'],
      inputs: [{ id: 'output-path', source: 'feature', path: 'outputPath', required: true, description: 'The exact authorized implementation-design output path.' }],
      steps: [{ id: 'design', instruction: 'Design interfaces, data flow, ownership, sequencing, and verification.' }, { id: 'map', instruction: 'Map planned behavior to concrete directories and contracts.' }, { id: 'verify-document', instruction: 'Verify completeness, risks, and the exact output path.' }],
      acceptance: ['Interfaces, data flow, risks, dependencies, and verification are explicit.', 'Every feature-to-directory mapping is evidence-backed.', 'The document-ref-v1 output identifies the exact written design and digest.'],
    }),
  }),
];
