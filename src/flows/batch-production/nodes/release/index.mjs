import { batchNode, batchTask } from '../node.mjs';

export const releasePrepareNode = batchNode('release-prepare', 'release-prepare', [], {
  readOnly: true,
  outputChecks: [{ portId: 'release-prepare', path: 'ready', operator: 'equals', value: true }],
  task: batchTask({
    role: { id: 'batch-release-preparer', description: 'Checks one batch item against the approved batch closure before candidate packaging.' },
    objective: 'Verify this item is included in the closed batch and ready for a frozen release candidate.',
    instructions: ['Inspect the pinned batch clearance and current source.', 'Check the item identity and declared release manifest.', 'Report an exact blocker for stale acceptance or missing content.'],
    steps: [{ id: 'inspect', instruction: 'Inspect the item and pinned batch closure.' }, { id: 'verify', instruction: 'Verify release manifest membership and current source identity.' }],
    constraints: ['Remain read-only.', 'Do not build, publish, or promote the candidate.'],
    acceptance: ['The item is present in the approved batch closure.', 'The batch-release-preparation-v1 result binds the item and batch.'],
  }),
});
