import { assert } from '../../common/errors.mjs';
import { defineNodeTaskContract, taskFeatureProjection } from '../../common/task-contract.mjs';
import { validateDeliveryBatches, deliveryBatchProjection, DELIVERY_BATCH_POLICY } from './delivery-batches.mjs';
import { approvedImplementationValueSchema } from './contracts/index.mjs';
import { digestJson } from '../../common/canonical.mjs';

const compactProposal = proposal => {
  const { deliveryBatches: _batches, ...value } = proposal;
  return structuredClone(value);
};

/** Lower approved deliveries to ordinary native Agent Features, never a CLI worker. */
export const compileDeliveryBatches = feature => {
  const proposal = feature.metadata.approvedProposal;
  if (proposal.deliveryPolicy !== DELIVERY_BATCH_POLICY) return [feature];
  const plan = validateDeliveryBatches(proposal);
  const lineage = [proposal];
  while (lineage.at(-1).splitFrom) lineage.push(feature.metadata.approvedDeliveryPlan.proposedFeatures.find(item => item.id === lineage.at(-1).splitFrom));
  const sourcePlan = { proposedFeatures: lineage.map(compactProposal) };
  for (const key of ['expandedPlan', 'sourceInventory']) if (feature.metadata.approvedDeliveryPlan[key]) sourcePlan[key] = feature.metadata.approvedDeliveryPlan[key];
  const obligationSetDigest = digestJson(plan.batches.flatMap(item => item.obligationIds).sort());
  const idFor = batch => batch.phase === 'convergence' ? feature.id : `${feature.id}/delivery/${batch.id}`;
  return plan.batches.map(batch => {
    const projection = deliveryBatchProjection(proposal, batch);
    const { taskDigest: _digest, ...task } = feature.task;
    const nextTask = taskFeatureProjection(defineNodeTaskContract({
      ...task, objective: batch.objective,
      instructions: [
        `Deliver the complete approved batch ${batch.id} of proposal ${proposal.id}. This native Agent is responsible for this moderate batch, not every delivery in the original proposal.`,
        'Read implementationContinuation.workBatch and its exact obligations/checks. Finish the cohesive batch, consumers and assigned evidence before returning. Do not stop at one file or certificate; do not absorb other batches to meet a workload percentage.',
        'A completed batch is a valid planned handoff. Return completed only when every assigned obligation and required check has bound evidence. Harness schedules other deliveries through the approved dependency/conflict graph; it never launches a CLI Agent fallback.',
        'If the batch cannot finish, preserve verified partial progress and the exact next action. Use the existing interruption, external-blocker and retry budget rules; a batch split never resets a shared budget.',
        'Use cached verification only when Harness marks its complete inputs, outputs and attested environment reusable. Source/config/toolchain changes invalidate dependent evidence. Final convergence requires fresh final checks and valid evidence for the entire original proposal.',
        'Complete outputs.implement using the packet outputValueSchemas.implement: exact proposalId, completedContracts and verificationResults. A non-convergence batch does not claim original Feature acceptance or source retirement authority.',
      ],
      steps: [{ id: 'inspect', instruction: 'Inspect the approved batch, current source, dependency evidence and feasible paths.' },
        { id: 'deliver', instruction: batch.objective }, { id: 'verify', instruction: 'Run the declared checks, retain exact checkpoints and report the complete batch.' }],
      acceptance: [...projection.contracts, ...projection.verification.map(value => `Verify: ${typeof value === 'string' ? value : JSON.stringify(value)}`)],
    }));
    return { ...feature, ...nextTask, id: idFor(batch),
      dependsOn: [...new Set([...feature.dependsOn, ...batch.dependsOn.map(id => idFor(plan.batches.find(item => item.id === id)))])],
      allowedPaths: [...batch.allowedPaths], contracts: [...projection.contracts],
      conflictKeys: [...(batch.conflictKeys ?? [])],
      metadata: { ...feature.metadata, approvedDeliveryPlan: sourcePlan,
        deliveryOwnerProposal: compactProposal(proposal),
        deliveryBatch: { ...batch, policy: DELIVERY_BATCH_POLICY, planDigest: plan.digest },
        deliveryPlanBinding: { planDigest: plan.digest, obligationSetDigest, batchDigest: digestJson(batch) },
        approvedProposal: batch.phase === 'convergence' ? projection : compactProposal(projection),
        ...(feature.metadata.amendmentProgressBaseline ? { amendmentProgressBaseline: {
          runId: feature.metadata.amendmentProgressBaseline.runId,
          sourceDigest: feature.metadata.amendmentProgressBaseline.sourceDigest,
          attempts: feature.metadata.amendmentProgressBaseline.attempts } } : {}),
        outputValueSchemas: { ...feature.metadata.outputValueSchemas, implement: approvedImplementationValueSchema(projection) } },
    };
  });
};

export const assertInheritedBudgetAvailable = (state, feature) => {
  const inherited = feature.metadata?.amendmentProgressBaseline?.attempts ?? {};
  const entries = Object.entries(inherited);
  for (const [key, before] of entries) {
    const current = state.attempts?.[key];
    assert(current && (current.used ?? current.failures) >= (before.used ?? before.failures)
      && current.limit >= before.limit, 'DELIVERY_BATCH_BUDGET_CARRYOVER_REQUIRED',
    'Historical budget counters must be carried through an authorized Run transition before dispatch; split metadata cannot reset the ledger.');
  }
};
