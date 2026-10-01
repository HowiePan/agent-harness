import { resolve } from 'node:path';
import { createHarness } from '../../../../src/application/harness.mjs';
import { recoverDevelopmentRun, selectDevelopmentRecoveryExtension } from '../../../../src/application/development-run-recovery.mjs';
import { verifyDevelopmentSourceManifest } from '../../../../src/application/development-source.mjs';
import { createLocalDevelopmentInvocation } from '../../../../src/application/local-development-invocation.mjs';
import { loadProjectHarnessConfig } from '../../../../src/application/project-initialization.mjs';
import { ExtensionRegistry } from '../../../../src/platform/extensions/registry.mjs';
import { createCodexRolloutHostExchange } from '../lib/codex-rollout-host-exchange.mjs';
import { createCodexCollaborationHostAdapter } from '../lib/codex-collaboration-host-adapter.mjs';
import { createHostExchangeDiagnosticWriter } from '../lib/host-exchange-diagnostics.mjs';
import { assertLocalProcessGateHost } from '../lib/local-process-gate-readiness.mjs';
import { digestJson } from '../../../../src/common/canonical.mjs';

const emit = value => process.stdout.write(`${JSON.stringify({ protocolVersion: '1.0', ...value })}\n`);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

const main = async () => {
  if (process.argv.length !== 6 || process.argv[2] !== '--manifest' || process.argv[4] !== '--run')
    fail('VISIBLE_DEVELOPMENT_RECOVERY_ARGUMENTS_INVALID', 'Usage: visible-development-recovery.mjs --manifest <source-link-manifest> --run <run-id>');
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
    if (old.metadata?.commandIntent?.action !== 'implement' || !old.metadata?.lifecycleInvocationId)
      fail('VISIBLE_DEVELOPMENT_RECOVERY_SCOPE_INVALID', 'Recovery only continues an existing authorized implementation lifecycle.');
    const commandId = `${old.metadata.lifecycleInvocationId}.development-recover.${runId}`;
    let recovery;
    if (old.status === 'superseded') {
      if (!old.metadata?.supersededReason?.startsWith('development-h3-recovery:')
        || !old.metadata?.supersededByRunId || !old.metadata?.supersedePlanDigest)
        fail('VISIBLE_DEVELOPMENT_RECOVERY_SCOPE_INVALID', 'The old Run was superseded by another operation.');
      recovery = { projectId, priorRunId: runId, replacementRunId: old.metadata.supersededByRunId,
        replacementPlanDigest: old.metadata.supersedePlanDigest, status: old.status, continuation: 'replacement-lifecycle-ready' };
    } else {
      try { recovery = await recoverDevelopmentRun({ manifestFile, runId, commandId }); }
      catch (error) {
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
        recovery = await recoverDevelopmentRun({ manifestFile, runId, commandId });
      }
    }
    emit({ kind: 'codex-visible-development-recovery', phase: 'run-retired', ...recovery });
    const intent = old.metadata.commandIntent;
    const project = await harness.projectRegistry.get(projectId);
    const extension = selectDevelopmentRecoveryExtension({ state: old, intent, project, installedExtensions: extensions });
    const plan = await harness.createLifecyclePlan({ projectId, extensionId: extension.id, workflowId: intent.workflowId,
      profileId: intent.profileId, action: intent.action, target: intent.target,
      arguments: intent.preset === 'default' ? [] : [intent.preset], executionWorkspaceRoot: old.metadata.workspace.root });
    if (plan.run.runId !== recovery.replacementRunId || plan.planDigest !== recovery.replacementPlanDigest) {
      const intended = await harness.authorityStore.read(projectId, recovery.replacementRunId, { required: false });
      const scope = features => features.map(feature => ({ id: feature.id, allowedPaths: feature.allowedPaths,
        forbiddenPaths: feature.forbiddenPaths, dependsOn: feature.dependsOn })).sort((left, right) => left.id.localeCompare(right.id));
      if (intended || plan.logicalTaskKey !== old.metadata.logicalTaskKey
        || digestJson(scope(plan.run.features)) !== digestJson(scope(old.features))
        || digestJson(plan.stopCondition) !== digestJson(old.metadata.stopCondition))
        fail('VISIBLE_DEVELOPMENT_RECOVERY_PLAN_CHANGED', 'The replacement Plan changed outside the retired Run ledger.');
      emit({ kind: 'codex-visible-development-recovery', phase: 'replacement-replanned', projectId,
        priorRunId: runId, retiredReplacementRunId: recovery.replacementRunId, runId: plan.run.runId,
        reason: 'retired-run-entered-quality-target-ledger' });
    }
    assertLocalProcessGateHost({ recipes: project.gateRecipes });
    const onGateProgress = event => emit({ kind: 'codex-visible-lifecycle-event', phase: 'gate-progress', event });
    const preflight = await harness.createExecutionReadinessReport(plan, { onGateProgress });
    emit({ kind: 'codex-visible-development-recovery', phase: 'preflight', projectId, runId: plan.run.runId,
      executionReady: preflight.executionReady, blockers: preflight.checks.filter(check => !check.ready).map(check => check.id) });
    if (!preflight.executionReady) { process.exitCode = 2; return; }
    const result = await harness.executeVisibleLifecyclePlan(plan, {
      commandId: `${old.metadata.lifecycleInvocationId}.development-continue.${runId}`,
      preflightReport: preflight, onGateProgress,
    });
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
