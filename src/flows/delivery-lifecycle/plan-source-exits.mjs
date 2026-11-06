import { assert } from '../../common/errors.mjs';

const nonempty = value => typeof value === 'string' && value.trim().length > 0;

// Cross-proposal dependencies wait for convergence. Within a proposal they
// wait for the exact predecessor batch, matching compileDeliveryBatches.
export const validatePlanSourceExits = (proposals, { requireDeclarations = () => false } = {}) => {
  for (const projectId of new Set(proposals.map(proposal => proposal.projectId))) {
    const owned = new Map(proposals.filter(proposal => proposal.projectId === projectId
      && proposal.disposition === 'project-owned').map(proposal => [proposal.id, proposal]));
    const predecessors = (id, dependencies) => {
      const seen = new Set();
      const visit = key => {
        if (seen.has(key)) return;
        seen.add(key);
        for (const dep of dependencies(key)) visit(dep);
      };
      for (const dep of dependencies(id)) visit(dep);
      seen.delete(id);
      return seen;
    };
    const proposalPredecessors = id => predecessors(id, key => owned.get(key)?.dependsOn ?? []);
    const before = (first, second) => first.proposal !== second.proposal
      ? proposalPredecessors(second.proposal.id).has(first.proposal.id)
      : predecessors(second.batch.id, key => second.proposal.deliveryBatches.find(batch => batch.id === key)?.dependsOn ?? []).has(first.batch.id);
    const resolveCheck = (ref, label) => {
      const proposal = owned.get(ref?.proposalId);
      const batch = proposal?.deliveryBatches?.find(item => item.id === ref?.batchId);
      const check = batch?.checks?.find(item => item.id === ref?.checkId);
      assert(check, 'PLAN_SOURCE_EXIT_CHECK_MISSING', `${label} references an unknown or external check ${ref?.proposalId}/${ref?.batchId}/${ref?.checkId}.`);
      return { proposal, batch, check };
    };
    const retired = new Set();
    for (const proposal of owned.values()) for (const batch of proposal.deliveryBatches ?? []) {
      const label = `${proposal.id}/${batch.id}`;
      for (const check of batch.checks ?? []) {
        if (check.requiresProposals === undefined) continue;
        const required = check.requiresProposals;
        assert(Array.isArray(required) && required.length && required.every(nonempty) && new Set(required).size === required.length,
          'PLAN_CHECK_PREREQUISITE_INVALID', `${label}/${check.id} needs distinct project-owned proposal IDs.`);
        const earlier = proposalPredecessors(proposal.id);
        for (const id of required) assert(owned.has(id) && earlier.has(id) && !proposalPredecessors(id).has(proposal.id),
          'PLAN_CHECK_PREREQUISITE_ORDER', `${label}/${check.id} requires ${id} to converge first. Check the command's real compilation scope and dependency graph.`);
      }
      if (batch.phase === 'source-exit' && requireDeclarations(proposal)) {
        assert(batch.sourceExits?.length, 'PLAN_SOURCE_EXIT_REQUIRED', `${label} needs a source exit declaration.`);
      }
      if (batch.sourceExits === undefined) continue;
      assert(Array.isArray(batch.sourceExits) && batch.sourceExits.length && ['source-exit', 'convergence'].includes(batch.phase),
        'PLAN_SOURCE_EXIT_INVALID', `${label} must declare source exits on a source-exit or convergence batch.`);
      for (const exit of batch.sourceExits) {
        const path = exit?.path;
        const context = `${label} exits ${path}`;
        assert(nonempty(path) && batch.writePaths?.includes(path) && !retired.has(path)
          && nonempty(exit.inventoryRef) && Array.isArray(exit.beforeChecks)
          && Array.isArray(exit.afterChecks) && exit.afterChecks.length,
        'PLAN_SOURCE_EXIT_INVALID', `${context} needs one exact planned write owner, a consumer inventory and post-exit verification.`);
        retired.add(path);
        for (const ref of exit.beforeChecks) {
          const prerequisite = resolveCheck(ref, context);
          assert(before(prerequisite, { proposal, batch }), 'PLAN_SOURCE_EXIT_ORDER',
            `${context} must follow replacement or consumer check ${ref.proposalId}/${ref.batchId}/${ref.checkId}.`);
        }
        for (const ref of exit.afterChecks) {
          const verification = resolveCheck(ref, context);
          assert(verification.check.cacheable === false && (verification.batch === batch || before({ proposal, batch }, verification)),
            'PLAN_SOURCE_EXIT_ORDER', `${context} needs fresh verification at or after exit: ${ref.proposalId}/${ref.batchId}/${ref.checkId}.`);
        }
      }
    }
  }
};

export const sourceExitPlanningInstructions = [
  'Inventory retiring source and interfaces from current source and pinned evidence. Follow imports, path-based includes, manifests, production and test targets, generated adapters, and downstream receivers. Record exact owners, replacement capabilities, and a coverage disposition for every affected assertion.',
  'For every source-exit batch or convergence batch that retires source, declare sourceExits: [{path, inventoryRef, beforeChecks, afterChecks}]. The exact retiring path must be in writePaths. Reference checks as {proposalId,batchId,checkId}. beforeChecks proves replacements and consumer migrations or completed handoff before exit; an empty list requires inventory evidence that no predecessor work is needed. afterChecks proves removal, preserved behavior and the original full verification at or after exit with cacheable:false.',
  'For each check, inspect actual command selection and compilation, including tests compiled but filtered out at runtime. Declare requiresProposals on checks that consume capabilities or migrated tests from other project-owned proposals; those proposals must already converge through dependsOn. Keep early focused checks distinct from later original full verification. Never schedule a cross-project proposal as a local producer or imply that a recorded downstream handoff grants writes.',
];

export const sourceExitReviewInstruction = 'Independently verify the source exit inventory against current references and the actual command/target selection. Reject missing declarations, omitted consumers, unavailable receivers, dropped assertions, checks that run before their producers, or changed full-acceptance obligations. For Amend trace the affected chain past the registered write boundaries, then report the exact scope gap instead of widening the delta.';
