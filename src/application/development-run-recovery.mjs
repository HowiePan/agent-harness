import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assert } from '../common/errors.mjs';
import { digestJson } from '../common/canonical.mjs';
import { readJson } from '../kernel/atomic-io.mjs';
import { verifyDevelopmentSourceManifest } from './development-source.mjs';
import { developmentPatchReceiptDigest } from './development-patch.mjs';
import { createLocalDevelopmentInvocation } from './local-development-invocation.mjs';
import { loadProjectHarnessConfig } from './project-initialization.mjs';
import { createHarness } from './harness.mjs';
import { ExtensionRegistry } from '../platform/extensions/registry.mjs';
import { CodexHostEffectJournal } from './codex-host-effect-journal.mjs';

const activeLeaseIds = state => state.leases.filter(lease => lease.status === 'active').map(lease => lease.leaseId).sort();
const activeDispatchIds = state => state.dispatches.filter(dispatch => ['requested', 'assigned'].includes(dispatch.status)).map(dispatch => dispatch.dispatchId).sort();

export const hasRejectedPlanReview = state => {
  if (state.status !== 'closure-blocked' || !state.features.some(feature => feature.metadata?.stage === 'plan-review' && feature.state === 'completed')) return false;
  const reviews = state.submissions.filter(submission => state.features.some(feature => feature.id === submission.featureId && feature.metadata?.stage === 'plan-review')
    && submission.result?.status === 'completed');
  return reviews.at(-1)?.result.outputs?.['plan-review']?.value?.approved === false;
};

export const selectDevelopmentRecoveryExtension = ({ state, intent, project, installedExtensions }) => {
  const workflow = state.metadata?.workflow;
  assert(workflow?.id === intent.workflowId && state.profile?.id === intent.profileId && state.metadata?.workspace?.root,
    'DEVELOPMENT_RUN_SCOPE_MISMATCH', 'Recovery cannot identify the original Workflow, Profile, and workspace.');
  const matches = installedExtensions.filter(extension => project.extensions?.some(bound => bound.id === extension.id && bound.digest === extension.digest)
    && extension.workflows?.some(item => item.id === intent.workflowId && item.profileId === intent.profileId));
  assert(matches.length === 1, 'DEVELOPMENT_RUN_SCOPE_MISMATCH', 'Recovery cannot uniquely identify the current project-bound Workflow.');
  return matches[0];
};

export const assertDevelopmentRunRecoveryEffects = (state, effects) => {
  const hostLeases = state.leases.filter(item => item.runtimeReceipt?.hostSpawnReceipt);
  assert(hostLeases.length > 0, 'DEVELOPMENT_RUN_HOST_LEASE_REQUIRED', 'Recovery requires a Lease with a completed Host observation.');
  for (const lease of hostLeases) {
    const dispatch = state.dispatches.find(item => item.dispatchId === lease.dispatchId);
    const spawn = lease.runtimeReceipt?.hostSpawnReceipt;
    const matches = effects.filter(effect => effect.effectId === spawn?.effectId && effect.binding?.projectId === state.projectId
      && effect.binding?.runId === state.runId && effect.binding?.dispatchId === dispatch?.dispatchId);
    assert(matches.length === 1, 'DEVELOPMENT_RUN_HOST_EFFECT_REQUIRED', 'Every active Lease must have one matching Codex Host Effect.', { leaseId: lease.leaseId });
    const effect = matches[0];
    const terminalResult = effect.state === 'settled' && ['result-observed', 'result-rejected'].includes(effect.outcome?.disposition);
    const hasDigests = (...values) => values.every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
    const fenced = effect.state === 'contained' && effect.outcome?.reason === 'development-run-recovery' && (
      (effect.outcome.disposition === 'absent-after-interrupt' && effect.outcome.target === lease.agentId
        && hasDigests(effect.outcome.observationRequestDigest, effect.outcome.interruptRequestDigest,
          effect.outcome.interruptResultDigest, effect.outcome.verificationRequestDigest))
      || (effect.outcome.disposition === 'interrupted' && effect.outcome.target === lease.agentId
        && hasDigests(effect.outcome.interruptRequestDigest, effect.outcome.interruptResultDigest,
          effect.outcome.verificationRequestDigest))
      || (effect.outcome.disposition === 'already-terminal' && effect.outcome.observedAgentName === lease.agentId
        && hasDigests(effect.outcome.observationRequestDigest)));
    assert((terminalResult || fenced)
      && effect.canonicalAgentName === lease.agentId && effect.nativeTaskName === spawn.nativeTaskName
      && effect.binding.packetDigest === dispatch.packetDigest
      && effect.binding.promptDigest === lease.runtimeReceipt?.prompt?.promptDigest
      && effect.sessionId === spawn.sessionId && effect.requestDigest === spawn.requestDigest,
    'DEVELOPMENT_RUN_HOST_EFFECT_UNSETTLED', 'The active Lease has no terminal result or identity-bound native absence fence.', { leaseId: lease.leaseId, effectId: effect.effectId });
  }
  assert(!effects.some(effect => effect.binding?.projectId === state.projectId && effect.binding?.runId === state.runId
    && !['settled', 'contained'].includes(effect.state)), 'DEVELOPMENT_RUN_HOST_EFFECT_PENDING', 'A Codex Host Effect for this Run is unresolved.');
};

const currentPatchReceipt = async (manifest, state) => {
  const root = resolve(manifest.dataRoot, 'development', 'patches');
  const entries = await readdir(root, { withFileTypes: true });
  const matches = [];
  for (const entry of entries.filter(item => item.isFile() && item.name.endsWith('.json'))) {
    const receipt = await readJson(resolve(root, entry.name));
    if (receipt?.kind !== 'development-patch-receipt' || receipt.manifestDigest !== manifest.manifestDigest) continue;
    assert(receipt.receiptDigest === developmentPatchReceiptDigest(receipt), 'DEVELOPMENT_PATCH_RECEIPT_DIGEST_MISMATCH', 'Development patch Receipt digest is invalid.');
    // A rejected Plan review also needs a new Plan after a corrected H1 template.
    // Its negative decision remains in the retired Run; it cannot grant writes.
    if ((['H2', 'H3'].includes(receipt.level) || (receipt.level === 'H1' && hasRejectedPlanReview(state))) && receipt.afterRuntimeDigest === manifest.release.artifactDigest
      && receipt.affectedRuns?.some(run => run.projectId === state.projectId && run.runId === state.runId && run.revision === state.revision
        && digestJson(run.activeLeaseIds ?? []) === digestJson(activeLeaseIds(state))
        && digestJson(run.activeDispatchIds ?? []) === digestJson(activeDispatchIds(state)))) matches.push(receipt);
  }
  assert(matches.length === 1, 'DEVELOPMENT_RUN_PATCH_RECEIPT_REQUIRED', 'Exactly one current H2/H3 patch Receipt, or H1 receipt for a rejected Plan review, must cover the unchanged Run and its active Leases.');
  return matches[0];
};

/** Retire a stopped source-link Run only after its Host effects and replacement Plan are verified. */
export const recoverDevelopmentRun = async ({ manifestFile, runId, commandId, cwd = process.cwd() }) => {
  assert(commandId && runId, 'DEVELOPMENT_RUN_RECOVERY_INPUT_REQUIRED', 'Development Run recovery requires a Run and command ID.');
  const { manifest, releaseIdentity } = await verifyDevelopmentSourceManifest(manifestFile);
  await createLocalDevelopmentInvocation({ projectRoot: manifest.projectRoot, configPath: manifest.configPath,
    controlRoot: manifest.controlRoot, dataRoot: manifest.dataRoot, cwd });
  const config = await loadProjectHarnessConfig(manifest.configPath, { projectRoot: manifest.projectRoot });
  const registry = new ExtensionRegistry({ dataRoot: manifest.dataRoot, controlRoot: manifest.controlRoot, developmentMode: true });
  const installedExtensions = await registry.loadInstalled();
  const harness = await createHarness({ controlRoot: manifest.controlRoot, dataRoot: manifest.dataRoot, releaseIdentity,
    extensions: installedExtensions, strictProjectIdentity: false, initializeStorage: false });
  const projectId = config.request.binding.projectId;
  const state = await harness.authorityStore.read(projectId, runId);
  assert(state.status !== 'closed' && state.status !== 'superseded' && state.metadata?.lifecycleInvocationId,
    'DEVELOPMENT_RUN_NOT_RECOVERABLE', 'Only an unfinished, lifecycle-owned Run can be retired by source-link recovery.');
  const receipt = await currentPatchReceipt(manifest, state);
  const intent = state.metadata.commandIntent;
  assert(intent?.action && intent?.target && intent?.workflowId && intent?.profileId && intent?.preset,
    'DEVELOPMENT_RUN_INTENT_REQUIRED', 'Recovery requires the original lifecycle command intent.');
  assert(!intent.workflowInput, 'DEVELOPMENT_RUN_WORKFLOW_INPUT_UNSUPPORTED', 'Recovery cannot recompile a pinned Workflow input without a new source capture.');
  const project = await harness.projectRegistry.get(projectId);
  const extension = selectDevelopmentRecoveryExtension({ state, intent, project, installedExtensions });
  const plan = await harness.createLifecyclePlan({ projectId, extensionId: extension.id, workflowId: intent.workflowId,
    profileId: intent.profileId, action: intent.action, target: intent.target,
    arguments: intent.preset === 'default' ? [] : [intent.preset], executionWorkspaceRoot: state.metadata.workspace.root });
  assert(plan.logicalTaskKey === state.metadata.logicalTaskKey && plan.run.runId !== runId && plan.planDigest !== state.metadata.lifecyclePlanDigest,
    'DEVELOPMENT_RUN_REPLACEMENT_INVALID', 'The current source did not produce a distinct Plan for the same logical task.');
  // Check the replacement Plan before fencing any Host effect. A source or
  // scope mismatch must leave the old Agent and Run untouched.
  if (state.dispatches.length > 0 || state.leases.length > 0) {
    const hostContract = state.leases.find(lease => lease.runtimeReceipt?.hostSpawnReceipt)?.runtimeReceipt.hostSpawnReceipt.contract;
    assert(hostContract, 'DEVELOPMENT_RUN_HOST_CONTRACT_REQUIRED', 'Recovery requires the bound Host contract.');
    const effects = new CodexHostEffectJournal({ controlRoot: manifest.controlRoot, dataRoot: manifest.dataRoot, contract: hostContract });
    assertDevelopmentRunRecoveryEffects(state, await effects.list());
  }
  const retired = await harness.kernel.supersedeRun(projectId, runId, {
    replacementRunId: plan.run.runId, planDigest: plan.planDigest,
    reason: `development-${receipt.level.toLowerCase()}-recovery:${receipt.receiptDigest}`,
  }, { expectedRevision: state.revision, commandId });
  return { projectId, priorRunId: runId, priorRevision: retired.state.revision, patchReceiptDigest: receipt.receiptDigest,
    replacementRunId: plan.run.runId, replacementPlanDigest: plan.planDigest, status: retired.state.status,
    continuation: 'new-lifecycle-command-ready' };
};
