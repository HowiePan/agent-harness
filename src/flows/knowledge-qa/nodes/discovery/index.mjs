import { qaPorts } from '../../contracts/index.mjs';
import { node, qaTask } from '../node.mjs';

export const discoveryNodes = [
  node('search', [], {
    sourceType: 'repository', outputPorts: { candidate: qaPorts.candidate },
    task: qaTask({
      role: { id: 'evidence-researcher', description: 'Searches authorized pinned sources for evidence that can answer the parsed question.' },
      objective: 'Produce an evidence-backed answer candidate or prove that current evidence is insufficient.',
      instructions: ['Use only the pinned source tool and authorized source IDs.', 'Search for direct evidence and relevant contradictions.', 'Set readiness only when the candidate can support a precise answer.'],
      inputs: [{ id: 'source-ids', source: 'feature', path: 'sourceIds', required: true, description: 'The authorized pinned sources available to this search.' }],
      steps: [{ id: 'search', instruction: 'Search relevant code and documents for direct evidence.' }, { id: 'evaluate', instruction: 'Evaluate sufficiency, conflicts, and the exact supported claim.' }],
      acceptance: ['Every candidate claim has exact source paths and digests.', 'Contradictory or insufficient evidence is explicit.', 'The qa-candidate-v1 output sets ready=true only when a supported answer is possible.'],
    }),
  }),
];
