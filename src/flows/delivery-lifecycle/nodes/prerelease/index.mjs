import { deliveryNode, deliveryTask } from '../node.mjs';

export const releasePrepareNode = deliveryNode('release-prepare', 'release-prepare', 'release-preparation', [], {
  task: deliveryTask({
    role: { id: 'release-preparer', description: 'Prepares version identity without changing functional behavior.' },
    objective: 'Align the declared release version and public package identity with the approved development clearance.',
    instructions: ['Read the pinned development clearance and current version identity.', 'Update only the declared version metadata paths.', 'Report all exact changes and verify that no functional implementation changed.'],
    steps: [{ id: 'inspect', instruction: 'Inspect version metadata and clearance.' }, { id: 'update', instruction: 'Set the release version in declared metadata files.' }, { id: 'verify', instruction: 'Verify version identity and report exact changes.' }],
    acceptance: ['Every release identity reports the target version.', 'Functional source is unchanged.', 'The typed result lists exact changed files.'],
    inputs: [{ id: 'development-clearance', source: 'intent', path: 'developmentClearance', required: true, description: 'Pinned development clearance Receipt.' }],
  }),
});

export const releaseDocsNode = deliveryNode('release-docs', 'release-docs', 'release-documentation', ['release-prepare'], {
  task: deliveryTask({
    role: { id: 'release-documentation-auditor', description: 'Audits the entire project-declared release documentation corpus and repairs proven drift.' },
    objective: 'Make all configured current and historical documentation consistent with verified implementation and authoritative evidence before candidate freeze.',
    instructions: ['Use the project-owned pinned documentation scope, not an inferred list.', 'Inspect every declared main file and every existing file under declared directories, including older version history.', 'Compare behavior, public API, examples, version claims, links, and earlier omissions with current source and immutable evidence.', 'Correct supported omissions and contradictions; preserve historical receipts and identify any issue that cannot be verified.', 'Return every audited file, every updated file, resolved issues, and unresolved issues.'],
    steps: [{ id: 'inventory', instruction: 'Enumerate the complete configured document corpus.' }, { id: 'audit', instruction: 'Cross-check current and historical claims against source and evidence.' }, { id: 'repair', instruction: 'Update all supported gaps inside the declared scope.' }, { id: 'report', instruction: 'Report exact coverage and unresolved issues.' }],
    acceptance: ['Every configured document has an audit disposition.', 'Known historical and current discrepancies are corrected with evidence.', 'Unresolved contradictions block candidate creation.'],
    inputs: [{ id: 'documentation-scope', source: 'intent', path: 'releaseDocumentation', required: true, description: 'Project-owned expanded documentation scope and digest.' }],
  }),
});
