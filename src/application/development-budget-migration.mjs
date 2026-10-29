import { digestJson, withoutKeys } from '../common/canonical.mjs';
import { assert } from '../common/errors.mjs';
import { AuthorityStore } from '../kernel/authority-store.mjs';
import { assertBudgetExtensionApproval, budgetExtensionDigest } from '../kernel/attempt-budget.mjs';
import { ProjectRegistry } from '../platform/registry/project-registry.mjs';
import { ExtensionRegistry } from '../platform/extensions/registry.mjs';
import { previewImplementationBudget, verifyImplementationBudgetScope } from './implementation-budget.mjs';
import { verifyDevelopmentSourceManifest } from './development-source.mjs';
import { createHarness } from './harness.mjs';

/** Verify the already approved budget before any H4 source/binding write. */
export const verifyMigrationBudgetExtension = async ({ manifest, runId, budgetExtension }) => {
  if (!budgetExtension) return null;
  const { proposal, approval } = budgetExtension;
  assert(proposal?.runId === runId && proposal.projectId && runId,
    'DEVELOPMENT_BUDGET_MIGRATION_SCOPE_MISMATCH', 'The approved budget must identify the exact migrating Run.');
  const authorityStore = new AuthorityStore({ root: manifest.dataRoot, controlRoot: manifest.controlRoot });
  const state = await authorityStore.read(proposal.projectId, runId);
  const projectRegistry = new ProjectRegistry({ root: manifest.dataRoot, controlRoot: manifest.controlRoot, strictIdentity: false });
  const current = await previewImplementationBudget({ harness: { projectRegistry }, state,
    development: { manifest }, request: proposal });
  assert(digestJson(current) === digestJson(proposal), 'BUDGET_EXTENSION_PROPOSAL_STALE', 'The approved migration budget no longer matches Authority.');
  assertBudgetExtensionApproval(proposal, approval);
  return structuredClone({ proposal, approval });
};

/** A verified H4 binding may record its sealed approval before retiring the old Run. */
export const applyMigrationBudgetExtension = async ({ manifestFile, patchReceipt, commandId }) => {
  const budgetExtension = patchReceipt.budgetExtension;
  if (!budgetExtension) return null;
  const development = await verifyDevelopmentSourceManifest(manifestFile);
  const { manifest, releaseIdentity } = development;
  assert(patchReceipt.level === 'H4' && patchReceipt.manifestDigest === manifest.manifestDigest
    && patchReceipt.afterRuntimeDigest === releaseIdentity.artifactDigest
    && patchReceipt.receiptDigest === digestJson(withoutKeys(patchReceipt, ['receiptDigest']))
    && patchReceipt.migrationRunId === budgetExtension.proposal.runId,
  'DEVELOPMENT_BUDGET_MIGRATION_RECEIPT_MISMATCH', 'Budget recording requires the verified H4 patch Receipt and exact Run.');
  const registry = new ExtensionRegistry({ dataRoot: manifest.dataRoot, controlRoot: manifest.controlRoot, developmentMode: true });
  const extensions = await registry.loadInstalled();
  const harness = await createHarness({ controlRoot: manifest.controlRoot, dataRoot: manifest.dataRoot,
    releaseIdentity, extensions, strictProjectIdentity: false, initializeStorage: false });
  const { proposal, approval } = budgetExtension;
  const state = await harness.authorityStore.read(proposal.projectId, proposal.runId);
  await verifyImplementationBudgetScope({ harness, state, development, featureId: proposal.featureId });
  const output = await harness.kernel.extendAttemptBudget(state.projectId, state.runId, { proposal, approval },
    { commandId, expectedRevision: proposal.expectedRevision });
  return { projectId: state.projectId, runId: state.runId, revision: output.state.revision,
    proposalDigest: proposal.proposalDigest, beforeLimit: proposal.beforeLimit, afterLimit: proposal.afterLimit,
    used: proposal.used, reused: output.reused, executionStarted: false };
};

/** Only the exact, one-transaction budget addition sealed in the patch can bridge its snapshot. */
export const approvedBudgetExtensionProgress = (run, state, receipt) => {
  if (receipt.level !== 'H4' || receipt.migrationRunId !== state.runId) return false;
  return exactBudgetTransition(run, state, receipt.budgetExtension);
};

/** An idle H2/H3 patch may precede one separately approved budget transaction. */
export const approvedPostPatchBudgetProgress = (run, state, receipt) => {
  if (!['H2', 'H3'].includes(receipt.level) || receipt.budgetExtension) return false;
  const extension = state.metadata?.attemptBudgetExtensions?.at(-1);
  if (!extension?.approval) return false;
  const proposal = withoutKeys(extension, ['approval', 'commandId', 'recordedAt']);
  const approval = withoutKeys(extension.approval, ['recordedAt', 'digest']);
  if (!run.authorityDigest || proposal.authorityDigest !== run.authorityDigest
    || proposal.sourceDigest !== run.sourceDigest || proposal.epoch !== run.epoch || proposal.generation !== run.generation
    || state.events.at(-1)?.sequence !== run.eventSequence + 1) return false;
  return exactBudgetTransition(run, state, { proposal, approval });
};

const exactBudgetTransition = (run, state, budgetExtension) => {
  try {
    const { proposal, approval } = budgetExtension ?? {};
    if (!proposal || proposal.proposalDigest !== budgetExtensionDigest(proposal)
      || run.projectId !== state.projectId || run.runId !== state.runId
      || run.activeLeaseIds.length || run.activeDispatchIds.length
      || state.leases.some(item => ['requested', 'active'].includes(item.status))
      || state.dispatches.some(item => ['requested', 'assigned'].includes(item.status))
      || state.revision !== run.revision + 1 || proposal.expectedRevision !== run.revision
      || proposal.projectId !== state.projectId || proposal.runId !== state.runId
      || proposal.sourceDigest !== state.sourceDigest || proposal.epoch !== state.epoch || proposal.generation !== state.generation
      || proposal.planDigest !== state.metadata?.lifecyclePlanDigest) return false;
    assertBudgetExtensionApproval(proposal, approval);
    const extension = state.metadata?.attemptBudgetExtensions?.at(-1);
    if (!extension || digestJson(Object.fromEntries(Object.keys(proposal).map(key => [key, extension[key]]))) !== digestJson(proposal)
      || extension.approval?.digest !== digestJson(approval)
      || !state.decisions.some(item => item.id === approval.id && item.digest === digestJson(approval))) return false;
    const command = state.commands?.[extension.commandId];
    if (command?.revision !== state.revision || command.payloadDigest !== digestJson({ proposal, approval })
      || digestJson(command.result?.extension) !== digestJson(extension)) return false;
    const attempt = state.attempts[proposal.attemptKey];
    const feature = state.features.find(item => item.id === proposal.featureId);
    const event = state.events.at(-1);
    return Boolean(attempt?.logicalRoot === proposal.logicalRoot && feature?.logicalRoot === proposal.logicalRoot
      && feature.state === 'blocked' && attempt.limit === proposal.afterLimit && !attempt.exhausted
      && (attempt.budgetKind === 'progress' ? attempt.used : attempt.failures) === proposal.used
      && [...state.submissions].reverse().find(item => item.featureId === feature.id)?.submissionId === proposal.latestSubmissionId
      && event?.type === 'attempt.budget-extended' && event.proposalDigest === proposal.proposalDigest
      && event.attemptKey === proposal.attemptKey && event.featureId === proposal.featureId
      && event.beforeLimit === proposal.beforeLimit && event.afterLimit === proposal.afterLimit && event.additional === proposal.additional
      && event.decisionId === approval.id);
  } catch { return false; }
};
