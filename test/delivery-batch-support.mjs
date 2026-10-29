import { digestJson } from '../src/common/canonical.mjs';
import { DELIVERY_BATCH_POLICY } from '../src/flows/delivery-lifecycle/delivery-batches.mjs';
import { expandApprovedImplementation } from '../src/flows/delivery-lifecycle/approved-implementation.mjs';
import { implementNode } from '../src/flows/delivery-lifecycle/nodes/implement/index.mjs';

export const obligationId = (kind, key) => `obligation:${digestJson({ kind, key })}`;
export const contract = 'Deliver working receiver and consumer.';
export const verification = 'Verify complete behavior.';
export const receiverId = obligationId('contract', contract);
export const finalId = obligationId('verification', verification);
export const makeCheck = (id, covers, inputs = ['src/receiver.mjs'], command = [process.execPath, 'verify.mjs']) => ({
  id, command, executionClass: 'deterministic-process', inputs, outputs: [], covers, environment: 'real local runtime', cacheable: true,
  toolchainFiles: [process.execPath],
});
export const batch = (id, ids, options = {}) => ({
  id, phase: 'development', objective: `Deliver coherent ${id} behavior.`, dependsOn: [],
  allowedPaths: ['src', 'verify.mjs'], writePaths: ['src'], obligationIds: ids,
  acceptance: [`Deliver ${id}.`], verification: [`Check ${id}.`],
  sizing: { basis: 'Implementation plus consumer and behavior assertions.', cohesion: 'One public behavior chain.',
    estimatedUnits: 4, capacityUnits: 8, reserve: 'Allow focused diagnosis and one integration repair.' },
  checks: [makeCheck(id, ids)], ...options,
});
export const proposal = () => ({
  id: 'F01', projectId: 'project', disposition: 'project-owned', dependsOn: [],
  allowedPaths: ['src', 'verify.mjs'], forbiddenPaths: ['.git'], contracts: [contract], verification: [verification],
  deliveryPolicy: DELIVERY_BATCH_POLICY, deliveryBatchReserve: 2,
  deliveryBatches: [batch('receiver', [receiverId]), batch('close', [finalId], {
    phase: 'convergence', dependsOn: ['receiver'], writePaths: [],
    checks: [{ ...makeCheck('final', [finalId]), cacheable: false }],
  })],
});
export const compile = (p = proposal(), typed = {}) => expandApprovedImplementation({ projectId: 'project', typedPlan: { ...typed, proposedFeatures: Array.isArray(p) ? p : [p] }, features: [{
  id: 'implement/V1', kind: 'implement', executionClass: 'agent-reasoning', logicalRoot: 'implement:V1',
  acceptance: ['Implement approved scope.'], task: implementNode.task, dependsOn: [],
  allowedPaths: ['src', 'verify.mjs'], forbiddenPaths: ['.git'], contracts: [], gatePlan: [],
  metadata: { stage: 'implementation', target: 'V1', workflow: { nodeId: 'implement' }, outputPorts: { implement: 'delivery-implementation-v1' } },
}] });
export const completion = (feature, changedFiles = []) => ({ status: 'completed', summary: `Complete ${feature.id}.`, changedFiles,
  checkpoints: feature.metadata.deliveryBatch.obligationIds.map(id => ({ id, status: 'completed', summary: 'Behavior proved.', evidence: ['verify.mjs'] })),
  outputs: { implement: { schemaId: 'delivery-implementation-v1', evidenceRefs: ['verify.mjs'], value: {
    changedFiles, proposalId: feature.metadata.approvedProposal.id, completedContracts: feature.metadata.approvedProposal.contracts,
    verificationResults: feature.metadata.approvedProposal.verification.map(item => ({ item, status: 'completed', evidenceRefs: ['verify.mjs'] })),
  } } },
});
