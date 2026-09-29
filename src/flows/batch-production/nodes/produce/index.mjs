import { batchNode, batchTask } from '../node.mjs';

export const produceNode = batchNode('produce', 'produce', ['rules'], {
  task: batchTask({
    role: { id: 'item-producer', description: 'Produces one batch item from its verified rule contract.' },
    objective: 'Implement every independently feasible part of the assigned item within its authorized paths and verified rules.',
    instructions: ['Consume the typed rule-readiness result and copy the complete requiredScenarios inventory from the item manifest into the produce output.', 'Inspect the current item state before editing.', 'Keep implementing and verifying independent scenarios after discovering a blocker.', 'When blocked, return requiredScenarios and scenarioAudit covering exactly those scenarios, an empty readyRemaining array, and evidenceRefs for each disposition. Use blocker.kind and each blocked scenario blockerKind = engine-artifact only for a verified published-artifact gap.', 'Report blocked only after all remaining scenarios have a precise engine-artifact blocker and no ready work remains. Never call a mapping defect, rule ambiguity, or stale capability declaration an engine defect.'],
    steps: [{ id: 'inspect', instruction: 'Inspect the item specification, current source, shared capabilities, and every required scenario.' }, { id: 'produce', instruction: 'Implement every feasible scenario, including those independent of a blocked scenario.' }, { id: 'verify', instruction: 'Run focused checks, account for every required scenario and changed file, and classify each remaining blocker against the pinned public artifact.' }],
    acceptance: ['Every required scenario is passed or has an evidence-backed blocker; no feasible work remains when reporting blocked.', 'The item conforms to every verified rule and declared specification.', 'No other item or shared capability is modified without authorization.', 'The batch-produce-v1 output reports the exact changed files and scenario dispositions.'],
  }),
});

export const produceNodes = [produceNode];
