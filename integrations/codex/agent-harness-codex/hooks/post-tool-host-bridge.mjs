import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHookBootstrapTrace } from '../lib/hook-bootstrap-diagnostics.mjs';
import { loadBindings } from './pseudo-command-router.mjs';

const relevant = name => name === 'Agent' || /^(?:collaboration\.)?(?:spawn_agent|list_agents|wait_agent|interrupt_agent)$/.test(name ?? '');

export const capturePostToolUse = async (event, options = {}) => {
  const trace = options.trace ?? await createHookBootstrapTrace({ event, options });
  await trace.record('hook-entered');
  try {
    await trace.record('event-parsed');
    if (event?.hook_event_name !== 'PostToolUse' || !relevant(event.tool_name)) {
      await trace.record('completed', { captured: false, reasonCode: 'CODEX_HOST_HOOK_EVENT_IRRELEVANT' });
      return { captured: false, reasonCode: 'CODEX_HOST_HOOK_EVENT_IRRELEVANT' };
    }
    const bindings = options.bindings ?? await loadBindings(options);
    await trace.record('bindings-resolved', {
      coreArtifactDigest: bindings.harness.release.artifactDigest,
      codexArtifactDigest: bindings.harness.release.channelArtifactDigest,
    });
    const bridge = options.bridge ?? await import(pathToFileURL(bindings.harness.hostBridgeModule).href);
    if (typeof bridge.captureHookToolResult !== 'function') throw Object.assign(new Error('Verified Host bridge module does not export captureHookToolResult.'), { code: 'CODEX_HOST_HOOK_BRIDGE_EXPORT_MISSING' });
    await trace.record('bridge-module-loaded');
    const result = await bridge.captureHookToolResult(event, { controlRoot: bindings.harness.controlRoot, dataRoot: bindings.harness.dataRoot });
    if (!result.captured) {
      await trace.record('failed', { captured: false, failureCode: result.reasonCode ?? 'CODEX_HOST_HOOK_PENDING_NOT_MATCHED' });
      return result;
    }
    await trace.record('pending-request-matched', { requestId: result.requestId });
    await trace.record('response-committed', { requestId: result.requestId, toolUseIdPresent: Boolean(result.toolUseId) });
    await trace.record('completed', { captured: true, requestId: result.requestId });
    return result;
  } catch (error) {
    await trace.record('failed', { captured: false, failureCode: error.code ?? 'CODEX_HOST_HOOK_UNEXPECTED_ERROR', failureName: error.name ?? 'Error' }).catch(() => {});
    throw error;
  }
};

const main = async () => {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  await capturePostToolUse(JSON.parse(raw));
  process.stdout.write('{}');
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`Agent Harness Host bridge Hook failed: ${error.code ?? 'UNEXPECTED_ERROR'} ${error.message}\n`);
    process.exitCode = 1;
  });
}
