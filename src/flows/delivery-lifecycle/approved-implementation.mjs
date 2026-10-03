import { assert } from '../../common/errors.mjs';
import { defineNodeTaskContract, taskFeatureProjection } from '../../common/task-contract.mjs';
import { validateWorkGraph } from '../../kernel/work-graph.mjs';

const packageId = (parent, proposal) => `${parent.id}/${proposal.id}`;
const validId = id => /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(id);

/** Compile approved, project-owned proposals into serial, auditable Features. */
export const expandApprovedImplementation = ({ features, typedPlan, projectId }) => {
  const parents = features.filter(feature => feature.metadata?.stage === 'implementation');
  assert(parents.length === 1, 'IMPLEMENTATION_FEATURE_REQUIRED', 'An approved standalone implementation requires one implementation Feature.');
  const parent = parents[0];
  const proposed = typedPlan?.proposedFeatures;
  assert(Array.isArray(proposed), 'IMPLEMENTATION_TYPED_PLAN_REQUIRED', 'The approved plan has no typed proposals.');
  const owned = proposed.filter(item => item.projectId === projectId && item.disposition === 'project-owned');
  assert(owned.length > 0 && owned.length <= 100, 'IMPLEMENTATION_PROPOSAL_COUNT_INVALID', 'The approved plan must have 1–100 project-owned proposals.');
  assert(owned.every(item => validId(item.id)) && new Set(owned.map(item => item.id)).size === owned.length,
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
        'For completed output implement.value, report proposalId, completedContracts as the exact approved contract strings, and verificationResults as one {item,status,evidenceRefs} entry per approved verification string. A deferred external or protected check needs status deferred, a specific reason, and the exact matching externalPrerequisite string.',
      ],
      inputs: [
        { id: 'approved-proposal', source: 'feature', path: 'approvedProposal', required: true, description: 'The exact project-owned proposal approved for this Feature.' },
        { id: 'approved-delivery-plan', source: 'feature', path: 'approvedDeliveryPlan', required: true, description: 'The approved typed plan containing proposal dependencies and external context.' },
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
        approvedDeliveryPlan: structuredClone(typedPlan),
        approvedProposal: structuredClone(proposal),
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
