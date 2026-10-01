import { deliveryNode, deliveryTask } from '../node.mjs';

export const implementNode = deliveryNode('implement', 'implement', 'implementation', ['plan-review'], {
  task: deliveryTask({
    role: { id: 'implementation-engineer', description: 'Implements the approved delivery plan inside the exact authorized paths.' },
    objective: 'Implement the planned behavior for the selected target with minimal, verified changes.',
    instructions: ['Consume the typed delivery plan from the Feature or upstream task input.', 'Implement every project-owned proposal for this Dispatch project, continuing from the current source and prior Submission when this Feature is reopened. Treat cross-project proposals as later external dependencies, not checks to run inside this Feature.', 'Run the declared Feature gatePlan and focused checks for project-owned changes; do not run a cross-project aggregate verify task.', 'Inspect the current implementation before editing.', 'Implement only planned behavior and run focused checks after each material change.', 'If verified source changes are complete for this attempt but project-owned proposals remain, return blocked with failureClass implementation-incomplete, the exact changedFiles, and a concise list of remaining project-owned work. Harness will continue this Feature automatically within its budget. Return completed only after all project-owned proposals and checks are done. Cross-project integration evidence, later independent review, and release approval do not block this implementation Feature.'],
    inputs: [
      { id: 'approved-delivery-plan', source: 'feature', path: 'approvedDeliveryPlan', required: false, description: 'The user-approved typed delivery plan for a standalone implementation Run.' },
      { id: 'upstream-delivery-plan', source: 'upstream', nodeId: 'plan', portId: 'plan', schemaId: 'delivery-plan-v1', required: false, description: 'The typed delivery plan produced within a full workflow Run.' },
    ],
    steps: [{ id: 'inspect', instruction: 'Inspect relevant source, contracts, tests, and generated assets.' }, { id: 'implement', instruction: 'Apply the smallest complete change within authorized paths.' }, { id: 'verify', instruction: 'Run focused checks and compare actual changes with the plan. If a required check fails solely because a child process cannot start (EPERM/access denied), retry the exact check once with narrowly scoped host elevation when available. Never skip the check or broaden write paths.' }],
    acceptance: ['Implemented behavior covers the planned Features without unauthorized scope.', 'Relevant focused checks pass or blocking evidence is returned.', 'The delivery-implementation-v1 output reports the exact changed files.'],
  }),
});

export const implementNodes = [implementNode];
