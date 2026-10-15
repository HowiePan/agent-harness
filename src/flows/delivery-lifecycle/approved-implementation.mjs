import { assert } from '../../common/errors.mjs';
import { defineNodeTaskContract, taskFeatureProjection } from '../../common/task-contract.mjs';
import { validateWorkGraph } from '../../kernel/work-graph.mjs';
import { uniqueProposalIds } from './proposal-id.mjs';
import { digestJson } from '../../common/canonical.mjs';
import { approvedImplementationValueSchema } from './contracts/index.mjs';

const packageId = (parent, proposal) => `${parent.id}/${proposal.id}`;

/** Compile approved, project-owned proposals into serial, auditable Features. */
export const expandApprovedImplementation = ({ features, typedPlan, projectId, approvalBinding = null }) => {
  const parents = features.filter(feature => feature.metadata?.stage === 'implementation');
  assert(parents.length === 1, 'IMPLEMENTATION_FEATURE_REQUIRED', 'An approved standalone implementation requires one implementation Feature.');
  const parent = parents[0];
  let approvedPlanBinding = null;
  if (approvalBinding) {
    assert(approvalBinding.projectId === projectId && approvalBinding.runId
      && /^[a-f0-9]{64}$/.test(approvalBinding.planDigest ?? '')
      && /^[a-f0-9]{64}$/.test(approvalBinding.artifactDigest ?? '')
      && digestJson(approvalBinding.typedPlan) === digestJson(typedPlan),
    'IMPLEMENTATION_APPROVAL_BINDING_MISMATCH', 'Approval context does not bind the exact project-owned typed plan.');
    const { typedPlan: _typedPlan, ...identity } = approvalBinding;
    approvedPlanBinding = { ...structuredClone(identity), typedPlanDigest: digestJson(typedPlan) };
  }
  const proposed = typedPlan?.proposedFeatures;
  assert(Array.isArray(proposed), 'IMPLEMENTATION_TYPED_PLAN_REQUIRED', 'The approved plan has no typed proposals.');
  const owned = proposed.filter(item => item.projectId === projectId && item.disposition === 'project-owned');
  assert(owned.length > 0 && owned.length <= 100, 'IMPLEMENTATION_PROPOSAL_COUNT_INVALID', 'The approved plan must have 1–100 project-owned proposals.');
  assert(uniqueProposalIds(owned),
    'IMPLEMENTATION_PROPOSAL_ID_INVALID', 'Project-owned proposal IDs must be unique, safe Feature segments.');
  const byId = new Map(owned.map(item => [item.id, item]));
  for (const item of owned) {
    assert(Array.isArray(item.dependsOn) && item.dependsOn.every(id => byId.has(id)),
      'IMPLEMENTATION_PROPOSAL_DEPENDENCY_INVALID', `Project-owned proposal ${item.id} depends on an absent or external proposal.`);
  }
  const ordered = [];
  const pending = new Map(owned.map(item => [item.id, item]));
  while (pending.size) {
    const ready = [...pending.values()].find(item => item.dependsOn.every(id => ordered.some(done => done.id === id)));
    assert(ready, 'IMPLEMENTATION_PROPOSAL_CYCLE', 'The approved project-owned proposals contain a dependency cycle.');
    ordered.push(ready);
    pending.delete(ready.id);
  }
  const packageFeatures = ordered.map((proposal, index) => {
    const prior = ordered[index - 1];
    const { taskDigest: _taskDigest, ...task } = parent.task;
    const contracts = proposal.contracts ?? [];
    const verification = proposal.verification ?? [];
    const projection = taskFeatureProjection(defineNodeTaskContract({
      ...task,
      objective: `Complete approved proposal ${proposal.id} for ${parent.metadata.target}.`,
      instructions: [
        `Implement only project-owned proposal ${proposal.id}; inspect its dependencies and current source before editing.`,
        'Finish the full proposal and its focused verification before returning completed. Do not use a small patch as a completion checkpoint.',
        'If a whole-project check fails only in files owned by another proposal, record the exact failure for that later proposal. Complete this proposal when its own approved contracts and verification pass; the Run still requires fresh final Gates after all proposals.',
        'If substantial verified source progress is made but the proposal remains incomplete, return blocked with failureClass implementation-incomplete, exact changedFiles, and remaining work. Harness may continue this same proposal within its bounded retry budget.',
        'Treat cross-project proposals and external release evidence as later integration inputs. Do not write another project or claim publication.',
        'When an approval binding is supplied, use its exact Authority plan, artifact, source and Decision identities for approval evidence. The sourceManifest describes source inputs and is not the plan approval record.',
        'For completed output implement.value, report proposalId, completedContracts as the exact approved contract strings, and verificationResults as one {item,status,evidenceRefs} entry per approved verification string. Successful verification entries must use status completed with non-empty evidenceRefs; status passed is not accepted in verificationResults. A deferred external or protected check needs status deferred, a specific reason, and the exact matching externalPrerequisite string. Validate this output against the proposal-specific outputValueSchemas.implement in the Dispatch packet.',
      ],
      inputs: [
        { id: 'approved-proposal', source: 'feature', path: 'approvedProposal', required: true, description: 'The exact project-owned proposal approved for this Feature.' },
        { id: 'approved-delivery-plan', source: 'feature', path: 'approvedDeliveryPlan', required: true, description: 'The approved typed plan containing proposal dependencies and external context.' },
        { id: 'approved-plan-binding', source: 'feature', path: 'approvedPlanBinding', required: false, description: 'Authority-bound plan approval identity and original user Decision; evidence context, not additional write authority.' },
      ],
      steps: [
        { id: 'inspect', instruction: `Inspect current source and approved dependencies for ${proposal.id}.` },
        { id: 'implement', instruction: `Complete all project-owned contracts in ${proposal.id}, including focused tests and necessary in-scope supporting files.` },
        { id: 'verify', instruction: `Run the checks declared for ${proposal.id} and report their actual evidence or a specific external deferral.` },
      ],
      acceptance: [
        `Complete proposal ${proposal.id} and report its ID in the delivery-implementation-v1 output.`,
        ...contracts.map((value, i) => `Contract ${i + 1}: ${value}`),
        ...verification.map((value, i) => `Verify ${i + 1}: ${value}`),
        'Provide exact changedFiles and evidence for every completed contract and verification item.',
      ],
      evidenceRequirements: [...task.evidenceRequirements, 'The completed output must identify the proposal and enumerate completed contracts and verification items exactly as approved.'],
    }));
    return {
      ...parent,
      ...projection,
      id: packageId(parent, proposal),
      logicalRoot: `${parent.logicalRoot}:${proposal.id}`,
      dependsOn: [...new Set([...parent.dependsOn, ...proposal.dependsOn.map(id => packageId(parent, byId.get(id))), ...(prior ? [packageId(parent, prior)] : [])])],
      // The Descriptor remains the write authority. Proposal paths guide the Agent;
      // a necessary sibling source file does not force a new user replan.
      allowedPaths: [...parent.allowedPaths],
      contracts: [...new Set([...parent.contracts, ...contracts])],
      attemptLimit: Math.max(parent.attemptLimit ?? 3, 21),
      metadata: {
        ...parent.metadata,
        outputValueSchemas: { ...parent.metadata.outputValueSchemas,
          implement: approvedImplementationValueSchema(proposal) },
        approvedDeliveryPlan: structuredClone(typedPlan),
        approvedProposal: structuredClone(proposal),
        ...(approvedPlanBinding ? { approvedPlanBinding } : {}),
        implementationProgressRetries: 20,
        allowDynamicDecomposition: false,
      },
    };
  });
  const lastId = packageFeatures.at(-1).id;
  const remaining = features.filter(feature => feature.id !== parent.id).map(feature => ({
    ...feature,
    dependsOn: feature.dependsOn.map(id => id === parent.id ? lastId : id),
  }));
  return validateWorkGraph([...packageFeatures, ...remaining]);
};
