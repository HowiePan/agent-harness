import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assert } from '../common/errors.mjs';
import { captureWorkspace, diffWorkspaceSnapshots } from '../common/workspace-snapshot.mjs';
import { digestJson, withoutKeys } from '../common/canonical.mjs';
import { readJson } from '../kernel/atomic-io.mjs';
import { verifyDevelopmentSourceManifest } from './development-source.mjs';
import { developmentPatchReceiptDigest } from './development-patch.mjs';
import { createLocalDevelopmentInvocation } from './local-development-invocation.mjs';
import { loadProjectHarnessConfig } from './project-initialization.mjs';
import { createHarness } from './harness.mjs';
import { ExtensionRegistry } from '../platform/extensions/registry.mjs';
import { CodexHostEffectJournal } from './codex-host-effect-journal.mjs';
import { validateBusinessResult } from '../platform/execution/result-contract.mjs';
import { expandApprovedImplementation } from '../flows/delivery-lifecycle/approved-implementation.mjs';
import { createCompletionCarryoverPlan, verifyCompletionCarryover } from '../kernel/completion-carryover.mjs';
import { assertPlanningReplacementScope, developmentRecoveryArguments, isPlanningRecovery } from './development-planning-recovery.mjs';
import { recoverInterruptedWorkspace, readInterruptedWorkspaceDraft } from './interrupted-workspace-recovery.mjs';

const activeLeaseIds = state => state.leases.filter(lease => lease.status === 'active').map(lease => lease.leaseId).sort();
const activeDispatchIds = state => state.dispatches.filter(dispatch => ['requested', 'assigned'].includes(dispatch.status)).map(dispatch => dispatch.dispatchId).sort();

export const hasRejectedPlanReview = state => {
  if (state.status !== 'closure-blocked' || !state.features.some(feature => feature.metadata?.stage === 'plan-review' && feature.state === 'completed')) return false;
  const reviews = state.submissions.filter(submission => state.features.some(feature => feature.id === submission.featureId && feature.metadata?.stage === 'plan-review')
    && submission.result?.status === 'completed');
  return reviews.at(-1)?.result.outputs?.['plan-review']?.value?.approved === false;
};

export const assertH4QualityRestartable = state => {
  assert(state.metadata?.commandIntent?.action === 'quality'
    && state.status === 'all-remaining-blocked'
    && state.features.some(feature => feature.metadata?.stage === 'quality' && feature.state === 'completed')
    && state.features.some(feature => feature.metadata?.stage === 'quality-repair' && feature.state === 'blocked')
    && state.features.every(feature => ['completed', 'blocked'].includes(feature.state))
    && !state.leases.some(lease => lease.status === 'active')
    && !state.dispatches.some(dispatch => ['requested', 'assigned'].includes(dispatch.status)),
  'DEVELOPMENT_H4_QUALITY_NOT_RESTARTABLE', 'H4 quality restart requires a reviewed, blocked, idle quality Run.');
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
    const resumedContainment = effect.outcome?.reason === 'preflight-reconciliation'
      && lease.status === 'superseded' && lease.generation === state.generation - 1
      && state.events.some(event => event.type === 'run.recovered' && event.mode === 'ordinary-resume'
        && event.epoch === state.epoch && event.generation === state.generation);
    const fenced = effect.state === 'contained' && (effect.outcome?.reason === 'development-run-recovery' || resumedContainment) && (
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

export const terminalFailureProgress = async (run, state, evidenceStore) => {
  if (run.activeLeaseIds?.length !== 1 || run.activeDispatchIds?.length !== 1
    || state.revision !== run.revision + 3 || state.sourceDigest === null) return false;
  const events = state.events.filter(event => event.sequence > run.revision + 1);
  if (events.length !== 3 || events[0].type !== 'lease.heartbeat'
    || events[0].progress !== 'terminal-failure-recovery'
    || events[1].type !== 'lease.heartbeat' || events[1].progress !== 'terminal-result-observed'
    || events[2].type !== 'submission.committed' || events[2].status !== 'blocked'
    || events[0].leaseId !== run.activeLeaseIds[0] || events[1].leaseId !== run.activeLeaseIds[0]) return false;
  const submission = state.submissions.find(item => item.submissionId === events[2].submissionId);
  const feature = state.features.find(item => item.id === submission?.featureId);
  const lease = state.leases.find(item => item.leaseId === submission?.leaseId);
  const dispatch = state.dispatches.find(item => item.dispatchId === submission?.dispatchId);
  if (!submission || submission.leaseId !== run.activeLeaseIds[0]
    || submission.dispatchId !== run.activeDispatchIds[0]
    || submission.featureId !== events[2].featureId || feature?.metadata?.stage !== 'implementation'
    || lease?.agentId !== submission.agentId || dispatch?.packetDigest !== lease?.packetDigest
    || submission.result?.status !== 'failed' || submission.result?.failureClass !== 'runtime-provider'
    || !submission.changedFiles?.length || submission.outputSourceDigest !== state.sourceDigest
    || submission.inputSourceDigest === state.sourceDigest
    || submission.submissionDigest !== digestJson(withoutKeys(submission, ['submissionDigest']))
    || submission.evidenceRefs?.length !== 1) return false;
  const evidence = await evidenceStore.read(submission.evidenceRefs[0]);
  const record = JSON.parse(evidence.bytes.toString('utf8'));
  const terminal = record.runtimeEvidence?.hostTerminalFailure;
  const hostResult = record.runtimeEvidence?.hostResultReceipt;
  const { receiptDigest, ...body } = terminal ?? {};
  return evidence.metadata.projectId === state.projectId && evidence.metadata.runId === state.runId
    && evidence.metadata.featureId === submission.featureId && evidence.metadata.dispatchId === submission.dispatchId
    && record.inputSourceDigest === submission.inputSourceDigest
    && record.outputSourceDigest === submission.outputSourceDigest
    && digestJson(record.result) === digestJson(submission.result)
    && terminal?.kind === 'host-terminal-failure-receipt' && receiptDigest === digestJson(body)
    && terminal.code === submission.result.blocker?.code
    && terminal.agentId === submission.agentId && terminal.dispatchId === submission.dispatchId
    && terminal.packetDigest === dispatch.packetDigest
    && terminal.promptDigest === lease.runtimeReceipt?.prompt?.promptDigest
    && terminal.resultDigest === digestJson({ ...submission.result, changedFiles: [] })
    && hostResult?.terminalFailureDigest === receiptDigest
    && hostResult.agentId === submission.agentId && hostResult.dispatchId === submission.dispatchId
    && hostResult.effectId === lease.runtimeReceipt?.hostSpawnReceipt?.effectId
    && hostResult.resultDigest === terminal.resultDigest;
};

const currentPatchReceipt = async (manifest, state, evidenceStore) => {
  const root = resolve(manifest.dataRoot, 'development', 'patches');
  const entries = await readdir(root, { withFileTypes: true });
  const matches = [];
  for (const entry of entries.filter(item => item.isFile() && item.name.endsWith('.json'))) {
    const receipt = await readJson(resolve(root, entry.name));
    if (receipt?.kind !== 'development-patch-receipt' || receipt.manifestDigest !== manifest.manifestDigest) continue;
    assert(receipt.receiptDigest === developmentPatchReceiptDigest(receipt), 'DEVELOPMENT_PATCH_RECEIPT_DIGEST_MISMATCH', 'Development patch Receipt digest is invalid.');
    // A rejected Plan review also needs a new Plan after a corrected H1 template.
    // Its negative decision remains in the retired Run; it cannot grant writes.
    if ((['H2', 'H3'].includes(receipt.level) || (receipt.level === 'H4' && receipt.migrationRunId === state.runId)
      || (receipt.level === 'H1' && hasRejectedPlanReview(state))) && receipt.afterRuntimeDigest === manifest.release.artifactDigest
    ) {
      for (const run of (receipt.affectedRuns ?? []).filter(item => item.projectId === state.projectId && item.runId === state.runId)) {
        const unchanged = run.revision === state.revision
          && digestJson(run.activeLeaseIds ?? []) === digestJson(activeLeaseIds(state))
          && digestJson(run.activeDispatchIds ?? []) === digestJson(activeDispatchIds(state));
        const draft = state.revision === run.revision + 1
          && state.events.at(-1)?.type === 'workspace.interrupted-draft-preserved'
          ? await readInterruptedWorkspaceDraft({ state, evidenceStore,
            controlRoot: manifest.controlRoot, dataRoot: manifest.dataRoot }) : null;
        if (unchanged || draft?.patchReceiptDigest === receipt.receiptDigest
          || await terminalFailureProgress(run, state, evidenceStore)) { matches.push(receipt); break; }
      }
    }
  }
  assert(matches.length === 1, 'DEVELOPMENT_RUN_PATCH_RECEIPT_REQUIRED', 'Exactly one current H2/H3 patch Receipt, an explicit H4 migration Receipt, or H1 receipt for a rejected Plan review must cover the unchanged Run.');
  return matches[0];
};

export const assessUnacceptedTerminalResult = ({ feature, result, before, after }) => {
  const nativeResult = validateBusinessResult(result, { conversationVisible: true, feature });
  assert(nativeResult.status === 'completed' && before?.digest && after?.digest,
    'DEVELOPMENT_RUN_RETIREMENT_RESULT_MISMATCH', 'Retirement requires a completed result and two source snapshots.');
  const pathWithin = (root, file) => file === root || file.startsWith(`${root.replace(/\/$/, '')}/`);
  const claimedChangedFiles = [...new Set(nativeResult.changedFiles.map(path => String(path).replaceAll('\\', '/')))].sort();
  const rejectedPaths = claimedChangedFiles.filter(path => !feature.allowedPaths.some(root => pathWithin(root, path))
    || feature.forbiddenPaths.some(root => pathWithin(root, path)));
  assert(rejectedPaths.length > 0, 'DEVELOPMENT_RUN_RETIREMENT_REJECTION_UNVERIFIED',
    'The pinned Feature does not substantiate rejection of the completed result.');
  const changedPaths = diffWorkspaceSnapshots(before, after);
  assert(claimedChangedFiles.every(path => changedPaths.includes(path)),
    'DEVELOPMENT_RUN_RETIREMENT_CLAIM_DRIFT', 'The original result claims a file absent from the current source delta.');
  return { claimedChangedFiles, rejectedPaths,
    unclaimedChangedPaths: changedPaths.filter(path => !claimedChangedFiles.includes(path)) };
};

/** Scheduling stores one Run-scoped workspace snapshot; the Dispatch binds it by sourceSnapshotRef. */
export const assertDispatchSourceSnapshotEvidence = ({ evidence, state, dispatch }) => {
  const metadata = evidence.metadata;
  const snapshot = JSON.parse(evidence.bytes.toString('utf8'));
  assert(metadata.ref === dispatch.sourceSnapshotRef
    && metadata.projectId === state.projectId && metadata.runId === state.runId
    && metadata.epoch === dispatch.epoch && metadata.epoch === state.epoch
    && metadata.generation === dispatch.generation && metadata.generation === state.generation
    && metadata.featureId === null && metadata.dispatchId === null
    && metadata.sourceDigest === dispatch.sourceDigest && metadata.sourceDigest === state.sourceDigest
    && metadata.artifactDigest === state.artifactDigest
    && metadata.policyDigest === state.policyDigest
    && metadata.pluginSetDigest === state.pluginSetDigest
    && metadata.labels?.includes('workspace-snapshot')
    && metadata.mediaType === 'application/json'
    && snapshot.protocolVersion === '1.0' && snapshot.root === resolve(state.metadata.workspace.root)
    && Array.isArray(snapshot.files) && snapshot.digest === digestJson(snapshot.files)
    && snapshot.digest === dispatch.sourceDigest,
  'DEVELOPMENT_RUN_RETIREMENT_SOURCE_EVIDENCE_INVALID',
  'The Run-scoped source snapshot does not bind this Dispatch and Authority baseline.');
  return snapshot;
};

export const planningRecoverySnapshots = async ({ state, plan, project, evidenceStore }) => {
  const running = state.features.filter(feature => feature.state === 'running');
  assert(running.length === 1 && running[0].metadata?.stage === 'version-planning',
    'DEVELOPMENT_PLANNING_RECOVERY_DISPATCH_REQUIRED', 'Planning recovery requires exactly one interrupted planning Feature.');
  const dispatches = state.dispatches.filter(dispatch => dispatch.featureId === running[0].id
    && dispatch.sourceDigest === state.sourceDigest && dispatch.sourceSnapshotRef);
  assert(dispatches.length === 1, 'DEVELOPMENT_PLANNING_RECOVERY_DISPATCH_REQUIRED',
    'Planning recovery requires the exact interrupted source snapshot.');
  const dispatch = dispatches[0];
  const before = assertDispatchSourceSnapshotEvidence({ evidence: await evidenceStore.read(dispatch.sourceSnapshotRef), state, dispatch });
  const after = await captureWorkspace(state.metadata.workspace.root, { excluded: project.workspace.excluded ?? [] });
  assertPlanningReplacementScope({ retired: state, plan, project, before, after });
  return { before, after };
};

export const commitUnacceptedDevelopmentRetirement = async ({ authorityStore, evidenceStore, state, lease, dispatch, feature,
  evidenceRef, patchReceiptDigest, hostReceiptDigest, resultDigest, observedSourceDigest,
  claimedChangedFiles, unclaimedChangedPaths, commandId, now = () => new Date().toISOString() }) => {
  const projectId = state.projectId;
  const runId = state.runId;
  const evidence = await evidenceStore.read(evidenceRef);
  const record = JSON.parse(evidence.bytes.toString('utf8'));
  assert(evidence.metadata.projectId === projectId && evidence.metadata.runId === runId
    && evidence.metadata.epoch === state.epoch && evidence.metadata.generation === state.generation
    && evidence.metadata.featureId === feature.id && evidence.metadata.dispatchId === dispatch.dispatchId
    && evidence.metadata.sourceDigest === state.sourceDigest
    && evidence.metadata.artifactDigest === state.artifactDigest
    && evidence.metadata.policyDigest === state.policyDigest
    && evidence.metadata.pluginSetDigest === state.pluginSetDigest
    && record.kind === 'unaccepted-terminal-result-retirement' && record.version === '1.0'
    && record.priorAuthorityDigest === state.authorityDigest
    && record.patchReceiptDigest === patchReceiptDigest
    && record.hostObservationReceipt?.receiptDigest === hostReceiptDigest
    && record.originalResultDigest === resultDigest
    && record.sourceDelta?.fromSourceDigest === state.sourceDigest
    && record.sourceDelta?.observedSourceDigest === observedSourceDigest
    && digestJson(record.sourceDelta.claimedChangedFiles) === digestJson(claimedChangedFiles)
    && digestJson(record.sourceDelta.unclaimedChangedPaths) === digestJson(unclaimedChangedPaths)
    && record.rejection?.code === 'FEATURE_PATH_NOT_ALLOWED'
    && record.rejection.rejectedPaths?.length > 0,
  'DEVELOPMENT_RUN_RETIREMENT_EVIDENCE_INVALID', 'Retirement evidence does not bind the current Run, Host result, rejection, and source delta.');
  const outcome = { projectId, priorRunId: runId, evidenceRef, patchReceiptDigest, observedSourceDigest,
    claimedChangedFiles, unclaimedChangedPaths, continuation: 'replan-command-ready' };
  const retired = await authorityStore.transact(projectId, runId,
    { expectedRevision: state.revision, commandId, payload: { ...outcome, priorAuthorityDigest: state.authorityDigest } }, currentState => {
      assert(currentState.authorityDigest === state.authorityDigest && currentState.status === 'running'
        && currentState.leases.some(item => item.leaseId === lease.leaseId && item.status === 'active')
        && currentState.dispatches.some(item => item.dispatchId === dispatch.dispatchId && item.status === 'assigned'),
      'DEVELOPMENT_RUN_RETIREMENT_AUTHORITY_CHANGED', 'Run Authority changed before trusted retirement.');
      const at = now();
      const activeLease = currentState.leases.find(item => item.leaseId === lease.leaseId);
      const activeDispatch = currentState.dispatches.find(item => item.dispatchId === dispatch.dispatchId);
      const activeFeature = currentState.features.find(item => item.id === feature.id);
      activeLease.status = 'superseded'; activeLease.supersededAt = at; activeLease.supersededReason = 'unaccepted-terminal-result';
      activeDispatch.status = 'superseded'; activeDispatch.supersededAt = at; activeDispatch.supersededReason = 'unaccepted-terminal-result';
      activeFeature.state = 'blocked';
      activeFeature.blocker = { kind: 'runtime-contract', code: 'FEATURE_PATH_NOT_ALLOWED',
        summary: 'Completed Agent result was rejected by the pinned Feature path contract.' };
      currentState.status = 'failed';
      currentState.evidenceRefs.push(...[evidenceRef].filter(ref => !currentState.evidenceRefs.includes(ref)));
      currentState.metadata = { ...currentState.metadata,
        unacceptedTerminalResult: { dispatchId: dispatch.dispatchId, resultDigest,
          hostReceiptDigest, evidenceRef },
        terminalOutcome: { status: 'failed', reason: 'unaccepted-terminal-result-for-replan',
          evidenceRefs: [evidenceRef], sourceDigest: currentState.sourceDigest, at } };
      currentState.events.push({ sequence: currentState.events.length + 1, type: 'run.failed', at,
        epoch: currentState.epoch, generation: currentState.generation,
        ...structuredClone(currentState.metadata.terminalOutcome) });
      return outcome;
    });
  return { ...outcome, status: retired.state.status, priorRevision: retired.state.revision };
};

/** Preserve a rejected native completion without assigning later workspace edits to its Feature. */
export const retireUnacceptedDevelopmentRun = async ({ manifestFile, runId, commandId, cwd = process.cwd() }) => {
  assert(commandId && runId, 'DEVELOPMENT_RUN_RETIREMENT_INPUT_REQUIRED', 'Retirement requires a Run and stable command ID.');
  const { manifest, releaseIdentity } = await verifyDevelopmentSourceManifest(manifestFile);
  await createLocalDevelopmentInvocation({ projectRoot: manifest.projectRoot, configPath: manifest.configPath,
    controlRoot: manifest.controlRoot, dataRoot: manifest.dataRoot, cwd });
  const config = await loadProjectHarnessConfig(manifest.configPath, { projectRoot: manifest.projectRoot });
  const registry = new ExtensionRegistry({ dataRoot: manifest.dataRoot, controlRoot: manifest.controlRoot, developmentMode: true });
  const extensions = await registry.loadInstalled();
  const harness = await createHarness({ controlRoot: manifest.controlRoot, dataRoot: manifest.dataRoot, releaseIdentity,
    extensions, strictProjectIdentity: false, initializeStorage: false });
  const projectId = config.request.binding.projectId;
  const state = await harness.authorityStore.read(projectId, runId);
  if (state.status === 'failed' && state.metadata?.terminalOutcome?.reason === 'unaccepted-terminal-result-for-replan') {
    const prior = state.commands?.[commandId];
    assert(prior?.result?.evidenceRef === state.metadata.unacceptedTerminalResult?.evidenceRef,
      'DEVELOPMENT_RUN_RETIREMENT_ALREADY_DONE', 'This Run was retired under another command.');
    return { ...structuredClone(prior.result), status: state.status, priorRevision: state.revision };
  }
  assert(state.status === 'running' && state.metadata?.commandIntent?.action === 'implement'
    && state.metadata?.lifecycleInvocationId && !state.findings.some(item => item.status !== 'resolved'),
  'DEVELOPMENT_RUN_RETIREMENT_SCOPE_INVALID', 'Only an active implementation Run without open Findings can be retired for a new plan.');
  const activeLeases = state.leases.filter(item => item.status === 'active');
  const activeDispatches = state.dispatches.filter(item => ['requested', 'assigned'].includes(item.status));
  assert(activeLeases.length === 1 && activeDispatches.length === 1
    && activeLeases[0].dispatchId === activeDispatches[0].dispatchId,
  'DEVELOPMENT_RUN_RETIREMENT_EFFECT_SCOPE_INVALID', 'Retirement requires exactly one active bound Lease and Dispatch.');
  const lease = activeLeases[0];
  const dispatch = activeDispatches[0];
  const feature = state.features.find(item => item.id === dispatch.featureId);
  assert(feature?.metadata?.stage === 'implementation' && feature.state === 'running'
    && lease.featureId === feature.id && lease.agentId === lease.runtimeReceipt?.hostSpawnReceipt?.agentId,
  'DEVELOPMENT_RUN_RETIREMENT_FEATURE_MISMATCH', 'The active Feature is not the bound implementation task.');
  const patch = await currentPatchReceipt(manifest, state, harness.evidenceStore);
  assert(['H2', 'H3'].includes(patch.level), 'DEVELOPMENT_RUN_RETIREMENT_PATCH_INVALID', 'Retirement requires a current H2/H3 repair Receipt.');
  const journal = new CodexHostEffectJournal({ controlRoot: manifest.controlRoot, dataRoot: manifest.dataRoot,
    contract: lease.runtimeReceipt.hostSpawnReceipt.contract });
  const effects = await journal.list();
  assertDevelopmentRunRecoveryEffects(state, effects);
  const effect = effects.find(item => item.effectId === lease.runtimeReceipt.hostSpawnReceipt.effectId);
  assert(effect?.state === 'settled' && effect.outcome?.disposition === 'result-observed'
    && effect.sessionId === lease.runtimeReceipt.hostSpawnReceipt.sessionId
    && effect.canonicalAgentName === lease.agentId && effect.binding?.dispatchId === dispatch.dispatchId,
  'DEVELOPMENT_RUN_RETIREMENT_HOST_UNVERIFIED', 'The original Agent completion is not bound to this active Lease.');
  // The original Host receipt and JSONL must agree byte-for-byte. A later chat
  // summary or a fresh list_agents result cannot substitute for that observation.
  const { readCodexRolloutObservation } = await import('../../integrations/codex/agent-harness-codex/lib/codex-rollout-host-exchange.mjs');
  const observed = await readCodexRolloutObservation({ controlRoot: manifest.controlRoot, dataRoot: manifest.dataRoot,
    sessionId: effect.sessionId, expectedCwd: state.metadata.workspace.root,
    observationRequestDigest: effect.outcome.observationRequestDigest, agentId: lease.agentId });
  assert(digestJson(observed.result) === effect.outcome.resultDigest,
  'DEVELOPMENT_RUN_RETIREMENT_RESULT_MISMATCH', 'The original completed Agent result differs from the settled Host Effect.');
  const sourceEvidence = await harness.evidenceStore.read(dispatch.sourceSnapshotRef);
  const before = assertDispatchSourceSnapshotEvidence({ evidence: sourceEvidence, state, dispatch });
  const project = await harness.projectRegistry.get(projectId);
  const workspaceRoot = state.metadata.workspace.root;
  const after = await captureWorkspace(workspaceRoot, { excluded: project.workspace.excluded ?? [] });
  const { claimedChangedFiles, rejectedPaths, unclaimedChangedPaths } = assessUnacceptedTerminalResult({
    feature, result: observed.result, before, after });
  const evidence = await harness.evidenceStore.put({
    kind: 'unaccepted-terminal-result-retirement', version: '1.0',
    priorAuthorityDigest: state.authorityDigest, patchReceiptDigest: patch.receiptDigest,
    hostEffectDigest: effect.effectDigest, hostObservationReceipt: observed.receipt,
    originalResult: observed.result, originalResultDigest: effect.outcome.resultDigest,
    rejection: { code: 'FEATURE_PATH_NOT_ALLOWED', rejectedPaths },
    sourceDelta: { fromSourceDigest: before.digest, observedSourceDigest: after.digest,
      claimedChangedFiles, unclaimedChangedPaths, attribution: 'unaccepted-agent-claim-and-unattributed-later-changes' },
  }, { mediaType: 'application/json', projectId, runId, epoch: state.epoch, generation: state.generation,
    featureId: feature.id, dispatchId: dispatch.dispatchId, sourceDigest: dispatch.sourceDigest,
    artifactDigest: state.artifactDigest, policyDigest: state.policyDigest, pluginSetDigest: state.pluginSetDigest,
    createdAt: observed.receipt.observedAt, labels: ['unaccepted-result', 'run-retirement'] });
  const current = await captureWorkspace(workspaceRoot, { excluded: project.workspace.excluded ?? [] });
  assert(current.digest === after.digest, 'DEVELOPMENT_RUN_RETIREMENT_SOURCE_DRIFT', 'Project source changed during retirement verification.');
  return commitUnacceptedDevelopmentRetirement({ authorityStore: harness.authorityStore, evidenceStore: harness.evidenceStore,
    state, lease, dispatch,
    feature, evidenceRef: evidence.ref, patchReceiptDigest: patch.receiptDigest,
    hostReceiptDigest: observed.receipt.receiptDigest, resultDigest: effect.outcome.resultDigest,
    observedSourceDigest: after.digest, claimedChangedFiles, unclaimedChangedPaths, commandId });
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
  let state = await harness.authorityStore.read(projectId, runId);
  assert(state.status !== 'closed' && state.status !== 'superseded' && state.metadata?.lifecycleInvocationId,
    'DEVELOPMENT_RUN_NOT_RECOVERABLE', 'Only an unfinished, lifecycle-owned Run can be retired by source-link recovery.');
  const receipt = await currentPatchReceipt(manifest, state, harness.evidenceStore);
  const intent = state.metadata.commandIntent;
  assert(intent?.action && intent?.target && intent?.workflowId && intent?.profileId && intent?.preset,
    'DEVELOPMENT_RUN_INTENT_REQUIRED', 'Recovery requires the original lifecycle command intent.');
  assert(!intent.workflowInput, 'DEVELOPMENT_RUN_WORKFLOW_INPUT_UNSUPPORTED', 'Recovery cannot recompile a pinned Workflow input without a new source capture.');
  const project = await harness.projectRegistry.get(projectId);
  if (state.metadata.commandIntent.action === 'implement'
    && state.events.at(-1)?.type === 'run.recovered' && state.events.at(-1).mode === 'ordinary-resume')
    state = await recoverInterruptedWorkspace({ state, project, authorityStore: harness.authorityStore,
    evidenceStore: harness.evidenceStore, controlRoot: manifest.controlRoot, dataRoot: manifest.dataRoot,
    commandId: `${commandId}.interrupted-source`, patchReceiptDigest: receipt.receiptDigest });
  const extension = selectDevelopmentRecoveryExtension({ state, intent, project, installedExtensions });
  const plan = await harness.createLifecyclePlan({ projectId, extensionId: extension.id, workflowId: intent.workflowId,
    profileId: intent.profileId, action: intent.action, target: intent.target,
    arguments: developmentRecoveryArguments(intent), executionWorkspaceRoot: state.metadata.workspace.root });
  assert(plan.logicalTaskKey === state.metadata.logicalTaskKey && plan.run.runId !== runId && plan.planDigest !== state.metadata.lifecyclePlanDigest,
    'DEVELOPMENT_RUN_REPLACEMENT_INVALID', 'The current source did not produce a distinct Plan for the same logical task.');
  const planningSource = isPlanningRecovery(state)
    ? await planningRecoverySnapshots({ state, plan, project, evidenceStore: harness.evidenceStore }) : null;
  if (receipt.level === 'H4' && intent.action === 'quality') {
    assertH4QualityRestartable(state);
    const snapshot = await captureWorkspace(state.metadata.workspace.root, { excluded: project.workspace.excluded ?? [] });
    assert(snapshot.digest === state.sourceDigest && plan.run.sourceDigest === state.sourceDigest,
      'DEVELOPMENT_H4_SOURCE_CHANGED', 'H4 quality restart requires the exact authoritative project source.');
    const hostContract = state.leases.find(lease => lease.runtimeReceipt?.hostSpawnReceipt)?.runtimeReceipt.hostSpawnReceipt.contract;
    assert(hostContract, 'DEVELOPMENT_RUN_HOST_CONTRACT_REQUIRED', 'Recovery requires the bound Host contract.');
    const effects = new CodexHostEffectJournal({ controlRoot: manifest.controlRoot, dataRoot: manifest.dataRoot, contract: hostContract });
    assertDevelopmentRunRecoveryEffects(state, await effects.list());
    const evidenceRefs = [...new Set(state.submissions.flatMap(item => item.evidenceRefs ?? []))];
    assert(evidenceRefs.length > 0, 'DEVELOPMENT_H4_QUALITY_EVIDENCE_REQUIRED', 'The stopped quality Run has no submission evidence.');
    const finished = await harness.kernel.finishRun(projectId, runId,
      { status: 'failed', reason: 'development-h4-quality-restart', evidenceRefs },
      { expectedRevision: state.revision, commandId });
    return { projectId, priorRunId: runId, priorRevision: finished.state.revision,
      patchReceiptDigest: receipt.receiptDigest, status: finished.state.status,
      continuation: 'new-quality-command-ready' };
  }
  if (receipt.level === 'H4' && intent.action === 'implement'
    && state.features.every(feature => feature.state === 'completed')
    && harness.profileRegistry.get(state.profile.id).canClose(state).reason === 'quality-review-limit-reached') {
    const snapshot = await captureWorkspace(state.metadata.workspace.root, { excluded: project.workspace.excluded ?? [] });
    assert(snapshot.digest === state.sourceDigest && plan.run.sourceDigest === state.sourceDigest,
      'DEVELOPMENT_H4_SOURCE_CHANGED', 'H4 quality terminalization requires the exact authoritative project source.');
    if (state.dispatches.length > 0 || state.leases.length > 0) {
      const hostContract = state.leases.find(lease => lease.runtimeReceipt?.hostSpawnReceipt)?.runtimeReceipt.hostSpawnReceipt.contract;
      assert(hostContract, 'DEVELOPMENT_RUN_HOST_CONTRACT_REQUIRED', 'Recovery requires the bound Host contract.');
      const effects = new CodexHostEffectJournal({ controlRoot: manifest.controlRoot, dataRoot: manifest.dataRoot, contract: hostContract });
      assertDevelopmentRunRecoveryEffects(state, await effects.list());
    }
    const finished = await harness.kernel.finishRun(projectId, runId,
      { status: 'incomplete', reason: 'quality-review-limit-reached',
        evidenceRefs: [...new Set(state.submissions.flatMap(item => item.evidenceRefs ?? []))] },
      { expectedRevision: state.revision, commandId });
    return { projectId, priorRunId: runId, priorRevision: finished.state.revision,
      patchReceiptDigest: receipt.receiptDigest, status: finished.state.status,
      continuation: 'new-quality-command-ready' };
  }
  const completedImplementation = state.metadata?.commandIntent?.action === 'implement'
    && state.features.some(feature => feature.metadata?.stage === 'implementation' && feature.state === 'completed');
  let completionCarryover = null;
  if (completedImplementation) {
    const typedPlan = state.metadata?.approvedPlan?.typedPlan;
    assert(typedPlan, 'CARRYOVER_APPROVED_PLAN_REQUIRED', 'Completed implementation requires its original approved typed plan.');
    const replacementFeatures = expandApprovedImplementation({ features: plan.run.features, typedPlan, projectId, approvalBinding: state.metadata.approvedPlan });
    assert(replacementFeatures.filter(feature => feature.metadata?.stage === 'implementation')
      .every(feature => feature.metadata?.workflow?.artifactDigest === plan.workflow?.artifactDigest),
    'CARRYOVER_REPLACEMENT_WORKFLOW_MISMATCH', 'Replacement Features do not bind the approved current Workflow.');
    const carryoverPlan = createCompletionCarryoverPlan({ prior: state, replacementFeatures,
      replacementRunId: plan.run.runId, replacementPlanDigest: plan.planDigest,
      patchReceiptDigest: receipt.receiptDigest, sourceDigest: plan.run.sourceDigest });
    await verifyCompletionCarryover({ plan: carryoverPlan, prior: state, replacementFeatures,
      evidenceStore: harness.evidenceStore, authorityStore: harness.authorityStore });
    completionCarryover = { plan: carryoverPlan, replacementPlan: plan };
  }
  // Check the replacement Plan before fencing any Host effect. A source or
  // scope mismatch must leave the old Agent and Run untouched.
  if (state.dispatches.length > 0 || state.leases.length > 0) {
    const hostContract = state.leases.find(lease => lease.runtimeReceipt?.hostSpawnReceipt)?.runtimeReceipt.hostSpawnReceipt.contract;
    assert(hostContract, 'DEVELOPMENT_RUN_HOST_CONTRACT_REQUIRED', 'Recovery requires the bound Host contract.');
    const effects = new CodexHostEffectJournal({ controlRoot: manifest.controlRoot, dataRoot: manifest.dataRoot, contract: hostContract });
    assertDevelopmentRunRecoveryEffects(state, await effects.list());
  }
  let draftEvidence = null;
  if (planningSource) {
    const current = await captureWorkspace(state.metadata.workspace.root, { excluded: project.workspace.excluded ?? [] });
    assert(current.digest === planningSource.after.digest, 'DEVELOPMENT_PLANNING_RECOVERY_SOURCE_DRIFT',
      'Planning source changed during Host containment; preserve the old Run.');
    draftEvidence = await harness.evidenceStore.put({ kind: 'unaccepted-planning-draft-recovery', version: '1.0',
      priorRunId: runId, priorAuthorityDigest: state.authorityDigest, patchReceiptDigest: receipt.receiptDigest,
      replacementRunId: plan.run.runId, replacementPlanDigest: plan.planDigest,
      ...assertPlanningReplacementScope({ retired: state, plan, project, ...planningSource }),
      snapshot: planningSource.after }, { projectId, runId, epoch: state.epoch, generation: state.generation,
      sourceDigest: state.sourceDigest, artifactDigest: state.artifactDigest, policyDigest: state.policyDigest,
      pluginSetDigest: state.pluginSetDigest, labels: ['unaccepted-planning-draft'] });
  }
  const retired = await harness.kernel.supersedeRun(projectId, runId, {
    replacementRunId: plan.run.runId, planDigest: plan.planDigest,
    reason: `development-${receipt.level.toLowerCase()}-recovery:${receipt.receiptDigest}`,
    ...(completionCarryover ? { completionCarryover } : {}),
  }, { expectedRevision: state.revision, commandId });
  return { projectId, priorRunId: runId, priorRevision: retired.state.revision, patchReceiptDigest: receipt.receiptDigest,
    ...(draftEvidence ? { unacceptedDraftEvidenceRef: draftEvidence.ref } : {}),
    replacementRunId: plan.run.runId, replacementPlanDigest: plan.planDigest, status: retired.state.status,
    ...(completionCarryover ? { completedFeatureIds: completionCarryover.plan.completedSubmissions.map(item => item.featureId),
      firstPendingFeatureId: completionCarryover.plan.firstPendingFeatureId, carryoverDigest: completionCarryover.plan.carryoverDigest } : {}),
    continuation: 'new-lifecycle-command-ready' };
};

/** Re-seal an unstarted replacement after a later source-link rebind. */
export const refreshPendingDevelopmentCarryover = async ({ manifestFile, commandId, cwd = process.cwd() }) => {
  assert(commandId, 'COMMAND_ID_REQUIRED', 'Pending carry-over refresh requires a command ID.');
  const { manifest, releaseIdentity } = await verifyDevelopmentSourceManifest(manifestFile);
  await createLocalDevelopmentInvocation({ projectRoot: manifest.projectRoot, configPath: manifest.configPath,
    controlRoot: manifest.controlRoot, dataRoot: manifest.dataRoot, cwd });
  const config = await loadProjectHarnessConfig(manifest.configPath, { projectRoot: manifest.projectRoot });
  const registry = new ExtensionRegistry({ dataRoot: manifest.dataRoot, controlRoot: manifest.controlRoot, developmentMode: true });
  const installedExtensions = await registry.loadInstalled();
  const harness = await createHarness({ controlRoot: manifest.controlRoot, dataRoot: manifest.dataRoot, releaseIdentity,
    extensions: installedExtensions, strictProjectIdentity: false, initializeStorage: false });
  const projectId = config.request.binding.projectId;
  const project = await harness.projectRegistry.get(projectId);
  const states = await harness.authorityStore.list(projectId);
  const pending = states.filter(state => state.status === 'superseded'
    && state.metadata?.completionCarryover?.replacementPlan
    && !states.some(candidate => candidate.runId === state.metadata.supersededByRunId));
  assert(pending.length <= 1, 'CARRYOVER_PENDING_AMBIGUOUS', 'More than one retired Run has an unstarted replacement Plan.');
  const prior = pending[0];
  if (!prior) return null;
  assert(/^development-h[23]-recovery:[a-f0-9]{64}$/.test(prior.metadata.supersededReason ?? '')
    && !activeLeaseIds(prior).length && !activeDispatchIds(prior).length,
  'CARRYOVER_REFRESH_SOURCE_INVALID', 'Only an idle H2/H3 recovery claim can be refreshed.');
  const intent = prior.metadata.commandIntent;
  assert(intent?.action === 'implement' && intent.workflowId && intent.profileId && intent.preset,
    'CARRYOVER_REFRESH_INTENT_INVALID', 'Pending claim is not a bound implementation command.');
  const extension = selectDevelopmentRecoveryExtension({ state: prior, intent, project, installedExtensions });
  const previous = prior.metadata.completionCarryover;
  assert(previous.plan?.replacementRunId === prior.metadata.supersededByRunId
    && previous.plan?.replacementPlanDigest === prior.metadata.supersedePlanDigest,
  'CARRYOVER_REFRESH_CLAIM_INVALID', 'Retired Run and its sealed replacement claim differ.');
  const typedPlan = prior.metadata.approvedPlan?.typedPlan;
  assert(typedPlan, 'CARRYOVER_APPROVED_PLAN_REQUIRED', 'Pending implementation carry-over requires its approved plan.');
  const previousFeatures = expandApprovedImplementation({ features: previous.replacementPlan.run.features, typedPlan, projectId, approvalBinding: prior.metadata.approvedPlan });
  await verifyCompletionCarryover({ plan: previous.plan, prior, replacementFeatures: previousFeatures,
    evidenceStore: harness.evidenceStore, authorityStore: harness.authorityStore });
  const plan = await harness.createLifecyclePlan({ projectId, extensionId: extension.id, workflowId: intent.workflowId,
    profileId: intent.profileId, action: intent.action, target: intent.target,
    arguments: intent.preset === 'default' ? [] : [intent.preset], executionWorkspaceRoot: prior.metadata.workspace.root },
  { ignorePendingCompletionCarryover: true });
  if (plan.planDigest === previous.replacementPlan.planDigest) return null;
  assert(plan.logicalTaskKey === prior.metadata.logicalTaskKey && plan.run.sourceDigest === prior.sourceDigest
    && plan.run.runId !== prior.runId && !states.some(state => state.runId === plan.run.runId),
  'CARRYOVER_REFRESH_REPLACEMENT_INVALID', 'Current Plan cannot safely replace the unstarted claim.');
  const replacementFeatures = expandApprovedImplementation({ features: plan.run.features, typedPlan, projectId, approvalBinding: prior.metadata.approvedPlan });
  const carryoverPlan = createCompletionCarryoverPlan({ prior: { ...prior, status: 'ready' }, replacementFeatures,
    replacementRunId: plan.run.runId, replacementPlanDigest: plan.planDigest,
    patchReceiptDigest: previous.plan.patchReceiptDigest, sourceDigest: plan.run.sourceDigest });
  await verifyCompletionCarryover({ plan: carryoverPlan, prior, replacementFeatures,
    evidenceStore: harness.evidenceStore, authorityStore: harness.authorityStore });
  const output = { projectId, priorRunId: prior.runId, priorReplacementRunId: previous.plan.replacementRunId,
    replacementRunId: plan.run.runId, firstPendingFeatureId: carryoverPlan.firstPendingFeatureId,
    carryoverDigest: carryoverPlan.carryoverDigest };
  await harness.authorityStore.transact(projectId, prior.runId,
    { expectedRevision: prior.revision, commandId, payload: output }, state => {
      assert(state.status === 'superseded' && state.metadata.supersededByRunId === previous.plan.replacementRunId
        && state.metadata.completionCarryover.plan.carryoverDigest === previous.plan.carryoverDigest,
      'CARRYOVER_REFRESH_AUTHORITY_CHANGED', 'Pending replacement changed before refresh.');
      state.metadata.supersededByRunId = plan.run.runId;
      state.metadata.supersedePlanDigest = plan.planDigest;
      state.metadata.completionCarryover = { plan: carryoverPlan, replacementPlan: plan };
      state.events.push({ sequence: state.events.length + 1, type: 'feature.completion-carryover-refreshed',
        at: new Date().toISOString(), epoch: state.epoch, generation: state.generation,
        previousReplacementRunId: previous.plan.replacementRunId, replacementRunId: plan.run.runId,
        carryoverDigest: carryoverPlan.carryoverDigest });
      return output;
    });
  return output;
};
