import { requirementsPorts } from '../../contracts/index.mjs';
import { node } from '../node.mjs';

export const intakeNodes = [
  node('ingest', [], { forEach: 'documents', sourceType: 'document', outputPorts: { facts: requirementsPorts.facts }, acceptance: ['Extract requirements and ambiguities from the pinned document with exact source locations.'] }),
  node('normalize', ['ingest'], { outputPorts: { requirements: requirementsPorts.requirements }, acceptance: ['Merge document facts into a complete requirement list and identify conflicts.'] }),
];
