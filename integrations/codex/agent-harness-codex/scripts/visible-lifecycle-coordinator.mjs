#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from '../../../../src/app/harness.mjs';
import { ExtensionRegistry } from '../../../../src/extensions/registry.mjs';
import { loadReleaseIdentity } from '../../../../src/release-identity.mjs';
import { validateActiveReleaseBinding } from '../lib/active-release-binding.mjs';
import { createCodexCollaborationHostAdapter } from '../lib/codex-collaboration-host-adapter.mjs';
import { createStdioHostExchange } from '../lib/stdio-host-exchange.mjs';
import { decodeVisibleLifecycleIntent } from '../lib/visible-lifecycle-intent.mjs';

const samePath = (left, right) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
  : resolve(left) === resolve(right);

const emit = value => process.stdout.write(`${JSON.stringify({ protocolVersion: '1.0', ...value })}\n`);

const main = async () => {
  if (process.argv.length !== 4 || process.argv[2] !== '--intent') throw Object.assign(new Error('Usage: visible-lifecycle-coordinator.mjs --intent <base64url-intent>'), { code: 'VISIBLE_LIFECYCLE_COORDINATOR_ARGUMENTS_INVALID' });
  const intent = decodeVisibleLifecycleIntent(process.argv[3]);
  const active = await validateActiveReleaseBinding({
    controlRoot: intent.harness.controlRoot,
    dataRoot: intent.harness.dataRoot,
    entrypoint: intent.harness.entrypoint,
    declaredRelease: intent.harness.release,
  });
  if (!samePath(active.coordinatorEntrypoint, intent.harness.coordinatorEntrypoint) || !samePath(active.coordinatorEntrypoint, fileURLToPath(import.meta.url))) throw Object.assign(new Error('Visible lifecycle intent does not target this verified active Coordinator.'), { code: 'VISIBLE_LIFECYCLE_COORDINATOR_IDENTITY_MISMATCH' });

  const releaseIdentity = await loadReleaseIdentity({ root: active.runtimeRoot, artifactDigest: active.artifactDigest });
  const extensionRegistry = new ExtensionRegistry({ dataRoot: intent.harness.dataRoot, controlRoot: intent.harness.controlRoot });
  const extensions = await extensionRegistry.loadInstalled();
  const stdio = createStdioHostExchange();
  try {
    const host = createCodexCollaborationHostAdapter({ exchange: stdio.exchange });
    const harness = await createHarness({
      controlRoot: intent.harness.controlRoot,
      dataRoot: intent.harness.dataRoot,
      releaseIdentity,
      extensions,
      agentAdapter: host.adapter,
    });
    const plan = await harness.createLifecyclePlan({
      projectId: intent.project.projectId,
      profileId: intent.project.profileId,
      extensionId: intent.project.extensionId,
      action: intent.command.action,
      target: intent.command.target,
      arguments: intent.command.arguments,
      executionWorkspaceRoot: intent.executionWorkspaceRoot,
    });
    emit({ kind: 'codex-visible-lifecycle-event', phase: 'planned', commandId: intent.commandId, intentDigest: intent.intentDigest, planDigest: plan.planDigest, plan });
    const onGateProgress = event => emit({ kind: 'codex-visible-lifecycle-event', phase: 'gate-progress', commandId: intent.commandId, planDigest: plan.planDigest, event });
    const preflight = await harness.createExecutionReadinessReport(plan, { onGateProgress });
    emit({ kind: 'codex-visible-lifecycle-event', phase: 'preflight', commandId: intent.commandId, intentDigest: intent.intentDigest, planDigest: plan.planDigest, executionReady: preflight.executionReady, report: preflight });
    if (!preflight.executionReady) {
      process.exitCode = 2;
      return;
    }
    const result = await harness.executeVisibleLifecyclePlan(plan, { commandId: intent.commandId, preflightReport: preflight, onGateProgress });
    emit({ kind: 'codex-visible-lifecycle-event', phase: 'complete', commandId: intent.commandId, intentDigest: intent.intentDigest, planDigest: plan.planDigest, status: result.status, result });
    if (!['closed', 'completed'].includes(result.status)) process.exitCode = 3;
  } finally {
    stdio.close();
  }
};

main().catch(error => {
  emit({ kind: 'codex-visible-lifecycle-error', code: error?.code ?? 'UNEXPECTED_ERROR', message: error?.message ?? String(error), details: error?.details ?? null });
  process.exitCode = 1;
});
