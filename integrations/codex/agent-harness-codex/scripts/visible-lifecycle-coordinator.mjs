#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from '../../../../src/application/harness.mjs';
import { ExtensionRegistry } from '../../../../src/platform/extensions/registry.mjs';
import { loadReleaseIdentity } from '../../../../src/application/release-identity.mjs';
import { validateActiveReleaseBinding } from '../lib/active-release-binding.mjs';
import { createCodexCollaborationHostAdapter } from '../lib/codex-collaboration-host-adapter.mjs';
import { assertMachineBoundQualityTransport } from '../lib/stdio-host-exchange.mjs';
import { createHookHostExchange } from '../lib/hook-host-exchange.mjs';
import { createCodexRolloutHostExchange } from '../lib/codex-rollout-host-exchange.mjs';
import { assertLocalProcessGateHost } from '../lib/local-process-gate-readiness.mjs';
import { createHostExchangeDiagnosticWriter } from '../lib/host-exchange-diagnostics.mjs';
import { decodeVisibleLifecycleIntent } from '../lib/visible-lifecycle-intent.mjs';
import { createPlannedLifecycleEvent, createPreflightLifecycleEvent } from '../lib/visible-lifecycle-events.mjs';
import { captureSourceManifest } from '../../../../src/platform/workflow/source-manifest.mjs';

const samePath = (left, right) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
  : resolve(left) === resolve(right);

const emit = value => process.stdout.write(`${JSON.stringify({ protocolVersion: '1.0', ...value })}\n`);
const renderWorkflowInput = (value, intent) => {
  if (value === '{command-timestamp}') return Date.parse(intent.createdAt);
  if (typeof value === 'string') return value.replaceAll('{target}', intent.command.target);
  if (Array.isArray(value)) return value.map(item => renderWorkflowInput(item, intent));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderWorkflowInput(item, intent)]));
  return value;
};

const main = async () => {
  const preflightOnly = process.argv.length === 5 && process.argv[4] === '--preflight-only';
  if (![4, 5].includes(process.argv.length) || process.argv[2] !== '--intent' || (process.argv.length === 5 && !preflightOnly)) throw Object.assign(new Error('Usage: visible-lifecycle-coordinator.mjs --intent <base64url-intent> [--preflight-only]'), { code: 'VISIBLE_LIFECYCLE_COORDINATOR_ARGUMENTS_INVALID' });
  const intent = decodeVisibleLifecycleIntent(process.argv[3]);
  const active = await validateActiveReleaseBinding({
    controlRoot: intent.harness.controlRoot,
    dataRoot: intent.harness.dataRoot,
    entrypoint: intent.harness.entrypoint,
    declaredRelease: intent.harness.release,
  });
  if (!samePath(active.coordinatorEntrypoint, intent.harness.coordinatorEntrypoint) || !samePath(active.coordinatorEntrypoint, fileURLToPath(import.meta.url))) throw Object.assign(new Error('Visible lifecycle intent does not target this verified active Coordinator.'), { code: 'VISIBLE_LIFECYCLE_COORDINATOR_IDENTITY_MISMATCH' });

  const developmentMode = active.mode === 'source-link';
  const releaseIdentity = developmentMode ? { version: active.version, artifactDigest: active.artifactDigest, verified: true, development: true } : await loadReleaseIdentity({ root: active.runtimeRoot, artifactDigest: active.artifactDigest });
  const extensionRegistry = new ExtensionRegistry({ dataRoot: intent.harness.dataRoot, controlRoot: intent.harness.controlRoot, developmentMode });
  const extensions = await extensionRegistry.loadInstalled();
  if (developmentMode && intent.codexSessionId !== process.env.CODEX_SESSION_ID) throw Object.assign(new Error('Source-link Coordinator must run in the Codex session named by its intent.'), { code: 'CODEX_ROLLOUT_SESSION_MISMATCH' });
  const hostOptions = { controlRoot: intent.harness.controlRoot, dataRoot: intent.harness.dataRoot, codexSessionId: intent.codexSessionId, onRejected: createHostExchangeDiagnosticWriter({ controlRoot: intent.harness.controlRoot, dataRoot: intent.harness.dataRoot }), ...(developmentMode ? { responseTimeoutMs: 600000 } : {}) };
  const hostExchange = developmentMode ? createCodexRolloutHostExchange(hostOptions) : createHookHostExchange(hostOptions);
  try {
    const host = createCodexCollaborationHostAdapter({
      exchange: hostExchange.exchange,
      controlRoot: intent.harness.controlRoot,
      dataRoot: intent.harness.dataRoot,
      ...(developmentMode ? { sessionId: intent.codexSessionId } : {}),
      ...(developmentMode ? { waitTimeoutMs: 10000 } : {}),
      memoryRoot: intent.harness.memoryRoot ?? null,
    });
    const harness = await createHarness({
      controlRoot: intent.harness.controlRoot,
      dataRoot: intent.harness.dataRoot,
      ...(intent.project.workspaceId ? { workspaceId: intent.project.workspaceId } : {}),
      releaseIdentity,
      extensions,
      strictProjectIdentity: !developmentMode,
      agentAdapters: { 'codex-conversation-runtime': host.adapter },
    });
    const descriptor = await harness.projectRegistry.get(intent.project.projectId);
    const workflowBinding = intent.project.workflowId ? descriptor.workflows?.find(workflow => workflow.id === intent.project.workflowId) : null;
    if (intent.project.workflowId && descriptor.workflows?.length && (!workflowBinding || workflowBinding.version !== intent.project.workflowVersion || workflowBinding.artifactDigest !== intent.project.workflowDigest || workflowBinding.extensionId !== intent.project.extensionId)) throw Object.assign(new Error('Visible lifecycle Workflow binding differs from the approved Project Descriptor.'), { code: 'VISIBLE_LIFECYCLE_WORKFLOW_IDENTITY_MISMATCH' });
    if (intent.project.workspaceId) {
      const workspace = await harness.workspaceRegistry.get(intent.project.workspaceId);
      const bound = workspace.workflows.find(workflow => workflow.id === intent.project.workflowId);
      const target = workspace.executionTargets.find(item => item.id === intent.project.executionTargetId);
      if (workspace.alias !== intent.project.workspaceAlias || !bound || bound.executionTargetId !== intent.project.executionTargetId || !target || !samePath(target.root, intent.executionWorkspaceRoot)) throw Object.assign(new Error('Visible lifecycle Workspace binding differs from the approved Registry.'), { code: 'VISIBLE_LIFECYCLE_WORKSPACE_IDENTITY_MISMATCH' });
    }
    let workflowInput = intent.project.workflowId ? renderWorkflowInput(descriptor.policy?.workflowInputs?.[intent.project.workflowId] ?? null, intent) : null;
    if (!intent.project.workspaceId && workflowInput?.sourceDeclarations) {
      workflowInput.sourceManifest = await captureSourceManifest({ projectId: descriptor.id, sources: workflowInput.sourceDeclarations });
      delete workflowInput.sourceDeclarations;
    }
    const plan = await harness.createLifecyclePlan({
      ...(intent.project.workspaceId ? { workspaceId: intent.project.workspaceId, workspaceAlias: intent.project.workspaceAlias, projectIds: intent.project.projectIds, executionTargetId: intent.project.executionTargetId } : { projectId: intent.project.projectId }),
      profileId: intent.project.profileId,
      extensionId: intent.project.extensionId,
      ...(intent.project.workflowId ? { workflowId: intent.project.workflowId } : {}),
      ...(workflowInput ? { workflowInput } : {}),
      action: intent.command.action,
      target: intent.command.target,
      arguments: intent.command.arguments,
      executionWorkspaceRoot: intent.executionWorkspaceRoot,
    });
    if (intent.project.workflowId && (plan.workflow?.id !== intent.project.workflowId || plan.workflow.version !== intent.project.workflowVersion || plan.workflow.artifactDigest !== intent.project.workflowDigest)) throw Object.assign(new Error('Visible lifecycle Plan differs from the verified Workflow binding.'), { code: 'VISIBLE_LIFECYCLE_WORKFLOW_IDENTITY_MISMATCH' });
    emit(createPlannedLifecycleEvent({ commandId: intent.commandId, intentDigest: intent.intentDigest, plan }));
    assertMachineBoundQualityTransport(hostExchange, intent.command.action);
    if (developmentMode) assertLocalProcessGateHost({ recipes: descriptor.gateRecipes });
    const onGateProgress = event => emit({ kind: 'codex-visible-lifecycle-event', phase: 'gate-progress', commandId: intent.commandId, planDigest: plan.planDigest, event });
    const preflight = await harness.createExecutionReadinessReport(plan, { onGateProgress });
    emit(createPreflightLifecycleEvent({ commandId: intent.commandId, intentDigest: intent.intentDigest, planDigest: plan.planDigest, report: preflight }));
    if (!preflight.executionReady) {
      process.exitCode = 2;
      return;
    }
    if (preflightOnly) return;
    const result = await harness.executeVisibleLifecyclePlan(plan, { commandId: intent.commandId, preflightReport: preflight, onGateProgress });
    emit({ kind: 'codex-visible-lifecycle-event', phase: 'complete', commandId: intent.commandId, intentDigest: intent.intentDigest, planDigest: plan.planDigest, status: result.status, result });
    if (!['closed', 'completed'].includes(result.status)) process.exitCode = 3;
  } finally {
    hostExchange.close();
  }
};

main().catch(error => {
  emit({ kind: 'codex-visible-lifecycle-error', code: error?.code ?? 'UNEXPECTED_ERROR', message: error?.message ?? String(error), details: error?.details ?? null });
  process.exitCode = 1;
});
