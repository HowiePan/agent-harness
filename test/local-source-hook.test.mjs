import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { harnessProjectRoot, harnessTemporaryRoot, writeDevelopmentSourceManifest } from '../src/index.mjs';
import { configureBindings } from '../integrations/codex/agent-harness-codex/scripts/configure-bindings.mjs';
import { handleLocalSourceHook, renderLocalSourceHooks } from '../integrations/codex/agent-harness-codex/hooks/local-source-hook.mjs';
import { runLocalSourceHostProbe } from '../integrations/codex/agent-harness-codex/scripts/local-source-host-probe.mjs';


test('source-linked project hooks route native tool evidence without a packaged plugin binding', async t => {
  const controlRoot = harnessProjectRoot();
  const parent = resolve(harnessTemporaryRoot(), 'local-source-hook-tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'case-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = resolve(root, 'consumer');
  const dataRoot = resolve(root, 'data');
  const pluginRoot = resolve(root, 'local-codex');
  await mkdir(resolve(projectRoot, '.git'), { recursive: true });
  await writeFile(resolve(projectRoot, 'README.md'), 'local source hook fixture\n');
  const configPath = resolve(projectRoot, 'harness.json');
  await writeFile(configPath, '{}\n');
  const source = await writeDevelopmentSourceManifest({ bindingId: 'local-debug', sourceRoot: controlRoot, controlRoot, dataRoot, configPath, projectRoot });
  const configured = await configureBindings({ pluginRoot, controlRoot, entrypoint: 'bin/agent-harness.mjs', dataRoot, projectSpecs: [`local-debug|local-debug-fixture|delivery-lifecycle|delivery-lifecycle-profile|${projectRoot}`], developmentManifest: source.file });
  const bindingsDir = resolve(pluginRoot, '.plugin-data');
  const hooks = await renderLocalSourceHooks({ bindingsDir });
  assert.match(hooks.hooks.PostToolUse[0].matcher, /list_agents/);
  assert.match(hooks.hooks.PostToolUse[0].hooks[0].command, /local-source-hook\.mjs/);
  assert.equal(JSON.parse(await readFile(configured.bindingFile, 'utf8')).harness.release.mode, 'source-link');

  const routed = await handleLocalSourceHook({ hook_event_name: 'UserPromptSubmit', prompt: 'h:where', cwd: projectRoot, session_id: 'local-source-session' }, { bindingsDir });
  assert.match(routed.hookSpecificOutput.additionalContext, /local-debug-fixture/);
  const quality = await handleLocalSourceHook({ hook_event_name: 'UserPromptSubmit', prompt: 'h:local-debug quality synthetic-v1', cwd: projectRoot, session_id: 'local-source-session' }, { bindingsDir });
  assert.match(quality.hookSpecificOutput.additionalContext, /本地源码适配说明/);
  assert.doesNotMatch(quality.hookSpecificOutput.additionalContext, /\$agent-harness-command/);
  const probePrompt = await handleLocalSourceHook({ hook_event_name: 'UserPromptSubmit', prompt: 'h:probe', cwd: projectRoot, session_id: 'local-source-session' }, { bindingsDir });
  assert.match(probePrompt.hookSpecificOutput.additionalContext, /local-source-host-probe\.mjs/);
  assert.match(probePrompt.hookSpecificOutput.additionalContext, /local-source-session/);

  const output = new PassThrough();
  const probe = runLocalSourceHostProbe({ bindingsDir, sessionId: 'local-source-session', output, responseTimeoutMs: 1000 });
  const [chunk] = await once(output, 'data');
  const request = JSON.parse(chunk.toString());
  assert.equal(request.tool, 'collaboration.list_agents');
  assert.deepEqual(request.arguments, {});
  assert.deepEqual(await handleLocalSourceHook({ hook_event_name: 'PostToolUse', tool_name: 'list_agents', tool_use_id: 'native-tool-local-source', tool_input: {}, tool_response: { agents: [] }, session_id: 'local-source-session', turn_id: 'local-source-turn' }, { bindingsDir }), {});
  const result = await probe;
  assert.equal(result.ok, true);
  assert.equal(result.requestId, request.requestId);
  assert.equal(result.agentCount, 0);
});
