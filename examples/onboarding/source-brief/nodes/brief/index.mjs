import { ports } from '../../contracts/index.mjs';
import { defineNodeTaskContract } from '../../../../../src/common/task-contract.mjs';

export const briefNodes = [{
  id: 'brief', template: 'reference-feature', dependsOn: [], readAllSources: true,
  outputKey: 'brief', outputPorts: { document: ports.document },
  outputValueSchemas: { document: { type: 'object', required: ['path'], properties: { path: { type: 'string', minLength: 1 } }, additionalProperties: true } },
  outputChecks: [{ portId: 'document', path: 'path', operator: 'output-path' }],
  acceptance: ['Read every pinned source available to the selected projects and write a concise evidence-backed brief.'],
  task: defineNodeTaskContract({
    role: { id: 'source-analyst', description: 'Evidence-backed analyst responsible for a complete multi-project source brief.' },
    objective: 'Produce one concise brief that accurately represents every pinned source in the selected project scope.',
    instructions: [
      'Read every source supplied through the immutable Source Manifest.',
      'Separate observed facts from interpretation and retain a source reference for each material claim.',
      'Write the completed brief only to the declared output path.',
    ],
    inputs: [
      { id: 'target', source: 'intent', path: 'target', required: true, description: 'The subject requested by the workspace command.' },
      { id: 'sources', source: 'source-manifest', path: '$', required: true, description: 'The pinned multi-project source manifest authorized for this run.' },
      { id: 'output-paths', source: 'intent', path: 'workflowInput.outputPaths', required: true, description: 'The output path mapping resolved from the workspace command.' },
    ],
    steps: [
      { id: 'inspect', instruction: 'Read every pinned source and record its immutable source reference.' },
      { id: 'synthesize', instruction: 'Synthesize the requested subject without inventing unsupported behavior.' },
      { id: 'write', instruction: 'Write the brief to the declared path and return the typed document reference.' },
    ],
    constraints: [
      'Do not read outside the Source Manifest or write outside the Feature allowlist.',
      'Do not omit a selected source even when it appears redundant.',
    ],
    acceptance: ['Every selected source is represented, every material claim is evidence-backed, and the document output satisfies document-ref-v1.'],
    evidenceRequirements: ['Return source references for all inspected inputs and the exact changed file path.'],
  }),
}];
