import { requirementsPorts } from '../../contracts/index.mjs';
import { node, requirementsTask } from '../node.mjs';

export const discoveryNodes = [
  node('search', ['normalize'], {
    forEach: 'repositories',
    sourceType: 'repository',
    outputPorts: { code: requirementsPorts.code },
    task: requirementsTask({
      role: { id: 'code-investigator', description: 'Finds requirement implementations and independent capabilities in one pinned repository.' },
      objective: 'Build complete code evidence for the normalized requirements and any material undocumented capabilities.',
      instructions: ['Consume the typed normalized requirements.', 'Search the entire assigned repository using the pinned source tool.', 'Record exact files, symbols, behaviors, and source digests.'],
      inputs: [{ id: 'source-ids', source: 'feature', path: 'sourceIds', required: true, description: 'The exact pinned repository assigned to this Feature.' }],
      steps: [{ id: 'search-requirements', instruction: 'Find code implementing or contradicting each requirement.' }, { id: 'search-capabilities', instruction: 'Identify independent material capabilities not represented by requirements.' }],
      acceptance: ['Each relevant code conclusion has exact source evidence.', 'Missing implementations and undocumented capabilities are explicit.', 'The code-evidence-v1 output binds evidence to the repository source ID.'],
    }),
  }),
  node('map', ['search'], {
    outputPorts: { impact: requirementsPorts.impact },
    task: requirementsTask({
      role: { id: 'impact-architect', description: 'Maps requirements to verified code evidence across repositories.' },
      objective: 'Produce a complete impact map covering implemented behavior, gaps, undocumented capabilities, and cross-repository effects.',
      instructions: ['Consume all typed repository search outputs.', 'Map each requirement to supporting or contradicting code evidence.', 'Identify missing behavior and cross-repository dependencies.'],
      steps: [{ id: 'map-requirements', instruction: 'Map every normalized requirement to code evidence and gaps.' }, { id: 'map-capabilities', instruction: 'Map undocumented capabilities and cross-repository effects.' }],
      acceptance: ['Every normalized requirement has an evidence-backed mapping or explicit gap.', 'Independent capabilities and cross-repository effects are represented.', 'The impact-map-v1 output is internally consistent.'],
    }),
  }),
];

export const codeDiscoveryNodes = [
  node('search', [], {
    forEach: 'repositories',
    sourceType: 'repository',
    outputPorts: { code: requirementsPorts.code },
    task: requirementsTask({
      role: { id: 'code-structure-investigator', description: 'Builds an evidence-backed structural and capability inventory for one repository.' },
      objective: 'Discover the repository architecture, modules, components, and user-visible capabilities without inventing requirements.',
      instructions: ['Search the entire assigned repository.', 'Identify directory structure, component boundaries, interfaces, and functional capabilities.', 'Cite exact paths and symbols for every conclusion.'],
      inputs: [{ id: 'source-ids', source: 'feature', path: 'sourceIds', required: true, description: 'The exact pinned repository assigned to this Feature.' }],
      steps: [{ id: 'inventory', instruction: 'Inventory modules, components, entrypoints, and boundaries.' }, { id: 'capabilities', instruction: 'Derive capabilities strictly from observed code evidence.' }],
      constraints: ['Do not represent a code-discovered capability as an approved requirement.'],
      acceptance: ['The repository structure and material capabilities are covered with exact evidence.', 'No requirement is invented.', 'The code-evidence-v1 output binds evidence to the repository source ID.'],
    }),
  }),
  node('map', ['search'], {
    outputPorts: { architecture: requirementsPorts.architecture },
    task: requirementsTask({
      role: { id: 'code-architecture-author', description: 'Synthesizes repository evidence into a code-only architecture model.' },
      objective: 'Produce a complete code architecture and capability-to-path map without fabricating requirement intent.',
      instructions: ['Consume all typed code search outputs.', 'Map modules, capabilities, dependencies, and feature-to-directory relationships.', 'Keep observed capability separate from inferred product intent.'],
      steps: [{ id: 'synthesize', instruction: 'Synthesize the structural architecture from repository evidence.' }, { id: 'map-capabilities', instruction: 'Map each observed capability to exact source paths.' }],
      constraints: ['Do not create or imply an approved requirement from code evidence alone.'],
      acceptance: ['Modules, capabilities, and capability-to-path mappings are complete.', 'Every mapping is supported by source evidence.', 'The code-architecture-v1 output contains no fabricated requirement.'],
    }),
  }),
];
