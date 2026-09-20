import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureHookToolResult } from '../lib/hook-host-exchange.mjs';
import { loadBindings } from './pseudo-command-router.mjs';

const relevant = name => name === 'Agent' || /^collaboration\.(spawn_agent|list_agents|wait_agent|interrupt_agent)$/.test(name ?? '');

export const capturePostToolUse = async (event, options = {}) => {
  if (event?.hook_event_name !== 'PostToolUse' || !relevant(event.tool_name)) return { captured: false };
  const bindings = options.bindings ?? await loadBindings(options);
  return captureHookToolResult(event, { controlRoot: bindings.harness.controlRoot, dataRoot: bindings.harness.dataRoot });
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
