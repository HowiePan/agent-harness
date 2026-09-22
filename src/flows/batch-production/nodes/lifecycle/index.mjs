import { batchNode, batchTask } from '../node.mjs';

export const launchNode = batchNode('launch', 'launch', [], {
  readOnly: true,
  task: batchTask({
    role: { id: 'batch-launch-controller', description: 'Checks batch-wide readiness without starting undeclared work.' },
    objective: 'Verify that the selected batch, items, shared capabilities, environment, and authority are ready to launch.',
    instructions: ['Inspect the approved batch declaration and prerequisites.', 'Verify item identities, dependencies, capacity, paths, and required authority.', 'Report exact blockers instead of partially launching.'],
    steps: [{ id: 'inspect-batch', instruction: 'Inspect the complete batch declaration and prerequisites.' }, { id: 'verify-launch', instruction: 'Verify launch readiness and record blockers.' }],
    constraints: ['Remain read-only and do not bypass the batch barrier.'],
    acceptance: ['All declared items and shared dependencies are valid and launchable.', 'The batch-launch-v1 output sets launched=true only when the whole launch contract is ready.'],
  }),
});

export const closeNode = batchNode('close', 'close', [], {
  readOnly: true,
  task: batchTask({
    role: { id: 'batch-close-controller', description: 'Verifies complete batch closure from item and shared-capability evidence.' },
    objective: 'Close the selected batch only after every item and shared capability has valid current acceptance.',
    instructions: ['Inspect all item acceptance, shared capability, Gate, Decision, and finding receipts.', 'Verify that the batch barrier and closure policy are satisfied.', 'Return a blocker for any missing or stale evidence.'],
    steps: [{ id: 'aggregate', instruction: 'Aggregate closure evidence for all items and shared capabilities.' }, { id: 'verify-close', instruction: 'Verify batch-wide closure and emit the closure result.' }],
    constraints: ['Remain read-only and never treat partial item completion as batch closure.'],
    acceptance: ['Every batch item and shared capability has valid current acceptance.', 'No required Gate, Decision, or unresolved P0-P3 finding is missing.', 'The batch-close-v1 output sets closed=true only when the batch is fully closed.'],
  }),
});

export const lifecycleNodes = [launchNode, closeNode];
