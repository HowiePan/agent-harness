import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHarness } from '../../../../src/application/harness.mjs';
import { recoverDevelopmentRun, retireUnacceptedDevelopmentRun, selectDevelopmentRecoveryExtension, planningRecoverySnapshots } from '../../../../src/application/development-run-recovery.mjs';
import { developmentRecoveryArguments, isPlanningRecovery } from '../../../../src/application/development-planning-recovery.mjs';
import { verifyDevelopmentSourceManifest } from '../../../../src/application/development-source.mjs';
import { createLocalDevelopmentInvocation } from '../../../../src/application/local-development-invocation.mjs';
import { loadProjectHarnessConfig } from '../../../../src/application/project-initialization.mjs';
import { ExtensionRegistry } from '../../../../src/platform/extensions/registry.mjs';
import { createCodexRolloutHostExchange } from '../lib/codex-rollout-host-exchange.mjs';
import { createCodexCollaborationHostAdapter } from '../lib/codex-collaboration-host-adapter.mjs';
import { createHostExchangeDiagnosticWriter } from '../lib/host-exchange-diagnostics.mjs';
import { assertLocalProcessGateHost } from '../lib/local-process-gate-readiness.mjs';
import { createLifecycleCommandPlan, validateLifecycleCommandPlan } from '../../../../src/application/lifecycle-command-plan.mjs';
import { assertDevelopmentReplacementScope } from '../../../../src/application/development-replacement-scope.mjs';

const emit = value => process.stdout.write(`${JSON.stringify({ protocolVersion: '1.0', ...value })}\n`);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

const main = async () => {
  const tail = process.argv.slice(6);
  const retireOnly = tail[0] === '--retire-only';
  const prepareOnly = tail[0] === '--prepare-only';
  const reviewFile = prepareOnly && tail.length === 3 && tail[1] === '--environment-review' ? tail[2] : null;
  if (process.argv[2] !== '--manifest' || !process.argv[3] || process.argv[4] !== '--run' || !process.argv[5]
    || !(tail.length === 0 || tail.length === 1 && (retireOnly || prepareOnly) || reviewFile))
    fail('VISIBLE_DEVELOPMENT_RECOVERY_ARGUMENTS_INVALID', 'Usage: visible-development-recovery.mjs --manifest <source-link-manifest> --run <run-id> [--retire-only|--prepare-only [--environment-review <json>]]');
  const environmentReview = reviewFile ? JSON.parse(await readFile(resolve(reviewFile), 'utf8')) : null;
  const onEnvironmentProgress = event => emit({ kind: 'codex-visible-development-recovery', phase: 'environment-review', event });
  const manifestFile = resolve(process.argv[3]);
  const runId = process.argv[5];
  const sessionId = process.env.CODEX_SESSION_ID;
  if (!sessionId) fail('CODEX_ROLLOUT_SESSION_INVALID', 'Recovery requires the current Codex session.');
  const { manifest, releaseIdentity } = await verifyDevelopmentSourceManifest(manifestFile);
  await createLocalDevelopmentInvocation({ projectRoot: manifest.projectRoot, configPath: manifest.configPath,
    controlRoot: manifest.controlRoot, dataRoot: manifest.dataRoot, cwd: process.cwd() });
  const config = await loadProjectHarnessConfig(manifest.configPath, { projectRoot: manifest.projectRoot });
  const projectId = config.request.binding.projectId;
  const registry = new ExtensionRegistry({ dataRoot: manifest.dataRoot, controlRoot: manifest.controlRoot, developmentMode: true });
  const extensions = await registry.loadInstalled();
  const hostExchange = createCodexRolloutHostExchange({ controlRoot: manifest.controlRoot, dataRoot: manifest.dataRoot,
    codexSessionId: sessionId, responseTimeoutMs: 1800000,
    onRejected: createHostExchangeDiagnosticWriter({ controlRoot: manifest.controlRoot, dataRoot: manifest.dataRoot }) });
  try {
    const host = createCodexCollaborationHostAdapter({ exchange: hostExchange.exchange, controlRoot: manifest.controlRoot,
      dataRoot: manifest.dataRoot, sessionId, waitTimeoutMs: 30000 });
    const harness = await createHarness({ controlRoot: manifest.controlRoot, dataRoot: manifest.dataRoot,
      releaseIdentity, extensions, strictProjectIdentity: false,
      agentAdapters: { 'codex-conversation-runtime': host.adapter } });
    const old = await harness.authorityStore.read(projectId, runId);
    if (!['plan', 'replan', 'amend', 'implement', 'produce', 'quality'].includes(old.metadata?.commandIntent?.action) || !old.metadata?.lifecycleInvocationId)
      fail('VISIBLE_DEVELOPMENT_RECOVERY_SCOPE_INVALID', 'Recovery only continues an existing authorized planning, implementation, production, or quality lifecycle.');
    const commandId = `${old.metadata.lifecycleInvocationId}.development-recover.${runId}`;
    if (retireOnly && (old.status === 'running' || old.status === 'failed')) {
      const lease = old.leases.find(item => item.status === 'active');
      const effectId = lease?.runtimeReceipt?.hostSpawnReceipt?.effectId;
      const effect = effectId ? await host.journal.read(effectId, { required: true }) : null;
      if (old.metadata?.terminalOutcome?.reason === 'unaccepted-terminal-result-for-replan'
        || effect?.state === 'settled' && effect.outcome?.disposition === 'result-observed'
          && !effect.outcome.terminalFailureDigest && !effect.outcome.rejectionDigest) {
        const retired = await retireUnacceptedDevelopmentRun({ manifestFile, runId,
          commandId: `${old.metadata.lifecycleInvocationId}.unaccepted-retire.${runId}` });
        emit({ kind: 'codex-visible-development-recovery', phase: 'run-retired', ...retired });
        return;
      }
    }
    const salvageTerminalFailure = async () => {
      const active = old.leases.filter(item => item.status === 'active');
      if (active.length !== 1 || old.dispatches.filter(item => ['requested', 'assigned'].includes(item.status)).length !== 1)
        fail('VISIBLE_DEVELOPMENT_RECOVERY_TERMINAL_SCOPE_INVALID', 'Source-drift recovery requires exactly one active bound Dispatch.');
      const lease = active[0];
      const dispatch = old.dispatches.find(item => item.dispatchId === lease.dispatchId);
      const feature = old.features.find(item => item.id === dispatch?.featureId);
      const effectId = lease.runtimeReceipt?.hostSpawnReceipt?.effectId;
      const effect = effectId ? await host.journal.read(effectId, { required: true }) : null;
      if (feature?.metadata?.stage !== 'implementation' || effect?.state !== 'settled'
        || effect.outcome?.disposition !== 'result-observed' || effect.canonicalAgentName !== lease.agentId
        || effect.binding?.dispatchId !== dispatch.dispatchId || effect.binding?.packetDigest !== dispatch.packetDigest)
        fail('VISIBLE_DEVELOPMENT_RECOVERY_TERMINAL_UNVERIFIED', 'Source-drift recovery requires the original terminal Host Effect and implementation Dispatch.');
      let state = await harness.authorityStore.read(projectId, runId);
      state = (await harness.recordHeartbeat(projectId, runId, { leaseId: lease.leaseId,
        dispatchId: dispatch.dispatchId, agentId: lease.agentId, progress: 'terminal-failure-recovery' },
      { expectedRevision: state.revision, commandId: `${commandId}.terminal-heartbeat.${dispatch.dispatchId}` })).state;
      const transported = await host.adapter.result({ agentId: lease.agentId, dispatchId: dispatch.dispatchId,
        visibility: structuredClone(lease.runtimeReceipt.visibility), runtimeReceipt: structuredClone(lease.runtimeReceipt) });
      if (!transported.runtimeEvidence?.hostTerminalFailure
        || transported.result?.status !== 'failed' || transported.result.changedFiles?.length !== 0
        || transported.receipt?.resultDigest !== effect.outcome.resultDigest)
        fail('VISIBLE_DEVELOPMENT_RECOVERY_TERMINAL_UNVERIFIED', 'The original Agent has no matching native terminal failure Receipt.');
      state = await harness.authorityStore.read(projectId, runId);
      state = (await harness.recordHeartbeat(projectId, runId, { leaseId: lease.leaseId,
        dispatchId: dispatch.dispatchId, agentId: lease.agentId, progress: 'terminal-result-observed' },
      { expectedRevision: state.revision, commandId: `${commandId}.terminal-result-heartbeat.${dispatch.dispatchId}` })).state;
      const submitted = await harness.recordResult(projectId, runId, dispatch.dispatchId, transported.result,
        { commandId: `${commandId}.terminal-submit.${dispatch.dispatchId}`,
          runtimeEvidence: { ...transported.runtimeEvidence, hostResultReceipt: transported.receipt } });
      const submission = submitted.state.submissions.find(item => item.dispatchId === dispatch.dispatchId);
      emit({ kind: 'codex-visible-development-recovery', phase: 'terminal-failure-recorded', projectId, runId,
        dispatchId: dispatch.dispatchId, submissionId: submission?.submissionId,
        changedFiles: submission?.changedFiles ?? [], sourceDigest: submitted.state.sourceDigest });
    };
    let recovery;
    if (old.status === 'superseded') {
      if (!/^development-h[234]-recovery:[a-f0-9]{64}$/.test(old.metadata?.supersededReason ?? '')
        || !old.metadata?.supersededByRunId || !old.metadata?.supersedePlanDigest)
        fail('VISIBLE_DEVELOPMENT_RECOVERY_SCOPE_INVALID', 'The old Run was superseded by another operation.');
      recovery = { projectId, priorRunId: runId, replacementRunId: old.metadata.supersededByRunId,
        replacementPlanDigest: old.metadata.supersedePlanDigest, status: old.status, continuation: 'replacement-lifecycle-ready' };
    } else {
      // Earlier preflights could finish ordinary resume with only not-observed
      // containment. Supplement it through native tools before source recovery;
      // a chat assertion or manually edited Host journal is never a substitute.
      const supplementInterruptedAbsence = async () => {
        if (old.events.at(-1)?.type !== 'run.recovered' || old.events.at(-1).mode !== 'ordinary-resume')
          fail('VISIBLE_DEVELOPMENT_RECOVERY_SCOPE_INVALID', 'Absence supplementation requires the immediately recovered transport.');
        for (const lease of old.leases.filter(item => item.status === 'superseded'
          && item.epoch === old.epoch && item.generation === old.generation - 1)) {
          const effectId = lease.runtimeReceipt?.hostSpawnReceipt?.effectId;
          const effect = effectId ? await host.journal.read(effectId, { required: true }) : null;
          if (effect?.state !== 'contained' || effect.outcome?.reason !== 'preflight-reconciliation'
            || effect.outcome.disposition !== 'not-observed') continue;
          const fenced = await host.adapter.contain({ agentId: lease.agentId, dispatchId: lease.dispatchId,
            runtimeReceipt: lease.runtimeReceipt, reason: 'development-run-recovery' });
          emit({ kind: 'codex-visible-development-recovery', phase: 'host-fenced', projectId, runId,
            effectId, disposition: fenced.outcome?.disposition });
        }
      };
      const recover = () => recoverDevelopmentRun({ manifestFile, runId, commandId, environmentReview, onEnvironmentProgress });
      try { recovery = await recover(); }
      catch (error) {
        if (error.code === 'INTERRUPTED_SOURCE_RECOVERY_UNVERIFIED' && error.details?.reason === 'native-containment') {
          // recoverDevelopmentRun has already verified the current H2/H3 Patch
          // Receipt and original project invocation before this native fence.
          await supplementInterruptedAbsence();
          recovery = await recover();
        } else if (error.code === 'CARRYOVER_SOURCE_CHANGED') {
          await salvageTerminalFailure();
          recovery = await recover();
        } else {
          if (!['DEVELOPMENT_RUN_HOST_EFFECT_UNSETTLED', 'DEVELOPMENT_RUN_HOST_EFFECT_PENDING'].includes(error.code)) throw error;
          for (const lease of old.leases.filter(item => item.status === 'active')) {
            const effectId = lease.runtimeReceipt?.hostSpawnReceipt?.effectId;
            const effect = effectId ? await host.journal.read(effectId, { required: true }) : null;
            if (effect?.state === 'lease-bound') {
              const fenced = await host.adapter.contain({ agentId: lease.agentId, dispatchId: lease.dispatchId,
                runtimeReceipt: lease.runtimeReceipt, reason: 'development-run-recovery' });
              emit({ kind: 'codex-visible-development-recovery', phase: 'host-fenced', projectId, runId,
                effectId, disposition: fenced.outcome?.disposition });
            }
          }
          for (const effect of await host.journal.unresolved()) {
            if (effect.binding?.projectId !== projectId || effect.binding?.runId !== runId) continue;
            const dispatch = old.dispatches.find(item => item.dispatchId === effect.binding.dispatchId);
            if (!dispatch || dispatch.packetDigest !== effect.binding.packetDigest)
              fail('VISIBLE_DEVELOPMENT_RECOVERY_EFFECT_MISMATCH', 'An unresolved Host Effect does not match the original Run dispatch.');
            if (old.leases.some(item => item.dispatchId === dispatch.dispatchId))
              fail('VISIBLE_DEVELOPMENT_RECOVERY_LEASE_UNSETTLED', 'An existing Lease still has an unresolved Host Effect.');
            const fenced = await host.adapter.contain({ effectId: effect.effectId, reason: 'development-run-recovery-unleased' });
            emit({ kind: 'codex-visible-development-recovery', phase: 'host-fenced', projectId, runId,
              effectId: effect.effectId, disposition: fenced.outcome?.disposition });
          }
          recovery = await recover();
        }
      }
    }
    emit({ kind: 'codex-visible-development-recovery', phase: 'run-retired', ...recovery });
    // Maintenance may prepare lineage for a later user-submitted command
    // without exercising the original command's continuation authority now.
    if (retireOnly) return;
    const intent = old.metadata.commandIntent;
    const project = await harness.projectRegistry.get(projectId);
    const extension = selectDevelopmentRecoveryExtension({ state: old, intent, project, installedExtensions: extensions });
    const retired = await harness.authorityStore.read(projectId, runId);
    const sealedReplacement = retired.metadata?.completionCarryover?.replacementPlan;
    let plan = sealedReplacement ? validateLifecycleCommandPlan(sealedReplacement)
      : await harness.createLifecyclePlan({ projectId, extensionId: extension.id, workflowId: intent.workflowId,
        profileId: intent.profileId, action: intent.action, target: intent.target,
        arguments: developmentRecoveryArguments(intent), executionWorkspaceRoot: old.metadata.workspace.root });
    if (sealedReplacement && (plan.run.runId !== recovery.replacementRunId
      || plan.planDigest !== recovery.replacementPlanDigest || plan.logicalTaskKey !== old.metadata.logicalTaskKey
      || plan.extension.id !== extension.id || plan.project.id !== projectId))
      fail('VISIBLE_DEVELOPMENT_RECOVERY_PLAN_CHANGED', 'The sealed replacement Plan does not match the retired Run and project binding.');
    if (!sealedReplacement && (plan.run.runId !== recovery.replacementRunId || plan.planDigest !== recovery.replacementPlanDigest)) {
      const intended = await harness.authorityStore.read(projectId, recovery.replacementRunId, { required: false });
      if (intended && intended.status !== 'closed' && intended.status !== 'superseded'
        && intended.metadata?.lifecyclePlanDigest === recovery.replacementPlanDigest
        && intended.metadata?.logicalTaskKey === old.metadata.logicalTaskKey
        && intended.metadata?.lifecycleInvocationId === `${old.metadata.lifecycleInvocationId}.development-continue.${runId}`) {
        const pinnedSourceDigest = intended.metadata?.lifecycleExecution?.authorizationSourceDigest;
        const reconstructed = createLifecycleCommandPlan({ intent: plan.intent, project, extension, releaseIdentity,
          sourceDigest: pinnedSourceDigest, executionWorkspaceRoot: intended.metadata.workspace.root,
          workspaceIdentity: intended.metadata.workspace.identity,
          executionConstraintDigest: plan.run.executionConstraintDigest,
          sourceToolBinding: plan.run.metadata?.sourceToolBinding ?? null,
          compiler: extension.operations?.createLifecyclePlan });
        if (reconstructed.run.runId === intended.runId
          && reconstructed.planDigest === recovery.replacementPlanDigest
          && reconstructed.logicalTaskKey === intended.metadata.logicalTaskKey) {
          plan = reconstructed;
          emit({ kind: 'codex-visible-development-recovery', phase: 'replacement-reattached', projectId,
            runId: intended.runId, planDigest: reconstructed.planDigest });
        }
      }
    }
    if (!sealedReplacement && (plan.run.runId !== recovery.replacementRunId || plan.planDigest !== recovery.replacementPlanDigest)) {
      const intended = await harness.authorityStore.read(projectId, recovery.replacementRunId, { required: false });
      if (intended)
        fail('VISIBLE_DEVELOPMENT_RECOVERY_PLAN_CHANGED', 'The replacement Plan changed outside the retired Run ledger.');
      const planningSource = isPlanningRecovery(retired)
        ? await planningRecoverySnapshots({ state: retired, plan, project, evidenceStore: harness.evidenceStore }) : null;
      assertDevelopmentReplacementScope({ retired, plan, project, planningSource });
      emit({ kind: 'codex-visible-development-recovery', phase: 'replacement-replanned', projectId,
        priorRunId: runId, retiredReplacementRunId: recovery.replacementRunId, runId: plan.run.runId,
        reason: 'retired-run-entered-quality-target-ledger' });
    }
    assertLocalProcessGateHost({ recipes: project.gateRecipes });
    const onGateProgress = event => emit({ kind: 'codex-visible-lifecycle-event', phase: 'gate-progress', event });
    const preflight = await harness.createExecutionReadinessReport(plan, { onGateProgress });
    emit({ kind: 'codex-visible-development-recovery', phase: 'preflight', projectId, runId: plan.run.runId,
      executionReady: preflight.executionReady, blockers: preflight.checks.filter(check => !check.ready).map(check => check.id),
      issues: preflight.checks.filter(check => !check.ready).map(check => ({ id: check.id, issues: check.issues })) });
    if (!preflight.executionReady) { process.exitCode = 2; return; }
    if (prepareOnly) {
      emit({ kind: 'codex-visible-development-recovery', phase: 'prepared', projectId,
        priorRunId: runId, runId: plan.run.runId, planDigest: plan.planDigest,
        executionReady: true, executionStarted: false });
      return;
    }
    const result = await harness.executeVisibleLifecyclePlan(plan, {
      commandId: `${old.metadata.lifecycleInvocationId}.development-continue.${runId}`,
      preflightReport: preflight, onGateProgress,
    });
    if (result.planApprovalArtifact) emit({ kind: 'codex-visible-lifecycle-event', phase: 'plan-review-ready',
      commandId: `${old.metadata.lifecycleInvocationId}.development-continue.${runId}`,
      status: result.planApprovalArtifact.reviewApproved ? 'awaiting-user-approval' : 'independent-review-rejected',
      artifact: result.planApprovalArtifact });
    emit({ kind: 'codex-visible-development-recovery', phase: 'complete', projectId, runId: plan.run.runId,
      status: result.status, reason: result.reason ?? null, revision: result.state?.revision ?? null });
    if (!['closed', 'completed'].includes(result.status)) process.exitCode = 3;
  } finally {
    hostExchange.close();
  }
};

main().catch(error => {
  emit({ kind: 'codex-visible-development-recovery', phase: 'error', code: error.code ?? 'UNEXPECTED_ERROR',
    message: error.message, details: error.details ?? null });
  process.exitCode = 1;
});
