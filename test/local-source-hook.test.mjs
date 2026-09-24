import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { harnessProjectRoot, harnessTemporaryRoot, writeDevelopmentSourceManifest } from '../src/index.mjs';
import { digestJson } from '../src/common/canonical.mjs';
import { resolveCommandIntent } from '../src/platform/extensions/command-contract.mjs';
import { deliveryLifecycleCommandManifest } from '../src/flows/delivery-lifecycle/commands.mjs';
import { configureBindings } from '../integrations/codex/agent-harness-codex/scripts/configure-bindings.mjs';
import { handleLocalSourceHook, renderLocalSourceHooks } from '../integrations/codex/agent-harness-codex/hooks/local-source-hook.mjs';
import { resolveProbeSessionId, runLocalSourceHostProbe } from '../integrations/codex/agent-harness-codex/scripts/local-source-host-probe.mjs';
import { createLocalSourceLifecycleCommand } from '../integrations/codex/agent-harness-codex/scripts/local-source-lifecycle-intent.mjs';
import { decodeVisibleLifecycleIntent } from '../integrations/codex/agent-harness-codex/lib/visible-lifecycle-intent.mjs';


test('source-linked project hooks route native tool evidence without a packaged plugin binding', async t => {
  const controlRoot = harnessProjectRoot();
  const parent = resolve(harnessTemporaryRoot(), 'local-source-hook-tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'case-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = resolve(root, 'consumer');
  const dataRoot = resolve(root, 'data');
  const pluginRoot = resolve(dataRoot, 'development', 'local-codex');
  await mkdir(resolve(projectRoot, '.git'), { recursive: true });
  await writeFile(resolve(projectRoot, 'README.md'), 'local source hook fixture\n');
  const configPath = resolve(projectRoot, 'harness.json');
  await writeFile(configPath, JSON.stringify({
    schemaVersion: '1.0', kind: 'agent-harness-project',
    extensions: [
      { id: 'delivery-lifecycle-profile', version: '1.0.0', module: 'agent-harness/consumers/delivery-lifecycle' },
      { id: 'codex-runtime', version: '1.0.0', module: 'agent-harness/extensions/codex-runtime' },
    ],
    project: { generatorExtensionId: 'delivery-lifecycle-profile', input: { gateRecipes: [] } },
    binding: { alias: 'local-debug', projectId: 'local-debug-fixture', profileId: 'delivery-lifecycle', extensionId: 'delivery-lifecycle-profile', workspaceRoot: '.' },
  }));
  const source = await writeDevelopmentSourceManifest({ bindingId: 'local-debug', sourceRoot: controlRoot, controlRoot, dataRoot, configPath, projectRoot });
  const configured = await configureBindings({ pluginRoot, controlRoot, entrypoint: 'bin/agent-harness.mjs', dataRoot, projectSpecs: [`local-debug|local-debug-fixture|delivery-lifecycle|delivery-lifecycle-profile|${projectRoot}`], workflowSpecs: [`local-debug|delivery-lifecycle|1.0.0|${'a'.repeat(64)}|delivery-lifecycle|delivery-lifecycle-profile`], developmentManifest: source.file });
  const bindingsDir = resolve(pluginRoot, '.plugin-data');
  const hooks = await renderLocalSourceHooks({ bindingsDir });
  assert.equal(hooks.hooks.PostToolUse, undefined);
  assert.match(hooks.hooks.UserPromptSubmit[0].hooks[0].command, /local-source-hook\.mjs/);
  assert.equal(hooks.hooks.UserPromptSubmit[0].hooks[0].timeout, 120);
  assert.equal(JSON.parse(await readFile(configured.bindingFile, 'utf8')).harness.release.mode, 'source-link');
  assert.equal(resolveProbeSessionId({ environmentSessionId: 'local-source-session' }), 'local-source-session');
  assert.throws(() => resolveProbeSessionId({ explicitSessionId: 'other-session', environmentSessionId: 'local-source-session' }), { code: 'LOCAL_SOURCE_HOST_PROBE_SESSION_MISMATCH' });
  const localCommand = await createLocalSourceLifecycleCommand({ bindingsDir, alias: 'local-debug', action: 'quality', target: 'fixture-v1', sessionId: 'local-source-session' });
  const localIntent = decodeVisibleLifecycleIntent(localCommand.coordinationIntent);
  assert.equal(localIntent.command.action, 'quality');
  assert.equal(localIntent.command.target, 'fixture-v1');
  assert.equal(localIntent.codexSessionId, 'local-source-session');
  assert.equal(localIntent.project.projectId, 'local-debug-fixture');
  await assert.rejects(() => createLocalSourceLifecycleCommand({ bindingsDir, alias: 'unknown', action: 'quality', target: 'fixture-v1', sessionId: 'local-source-session' }), { code: 'LOCAL_SOURCE_PROJECT_ALIAS_UNKNOWN' });
  const routed = await handleLocalSourceHook({ hook_event_name: 'UserPromptSubmit', prompt: 'h:local local-debug quality fixture-v1', cwd: projectRoot, session_id: 'local-source-session' }, { bindingsDir });
  assert.match(routed.hookSpecificOutput.additionalContext, /本地源码 Coordinator/);
  const routedIntent = JSON.parse(routed.hookSpecificOutput.additionalContext.split('解析结果：').at(-1));
  const qualityCommand = decodeVisibleLifecycleIntent(routedIntent.coordinationIntent).command;
  assert.equal(qualityCommand.target, 'fixture-v1');
  assert.equal(resolveCommandIntent(deliveryLifecycleCommandManifest, qualityCommand).sourcePolicy, 'review-and-repair');
  const unknownAlias = await handleLocalSourceHook({ hook_event_name: 'UserPromptSubmit', prompt: 'h:local unknown quality fixture-v1', cwd: projectRoot, session_id: 'local-source-session' }, { bindingsDir });
  assert.equal(unknownAlias.decision, 'block');
  assert.match(unknownAlias.reason, /LOCAL_SOURCE_COMMAND_INTENT_MISSING/);
  assert.match(unknownAlias.reason, /P2/);
  assert.match(unknownAlias.reason, /restore-trusted-binding-then-retry-command/);
  const malformed = await handleLocalSourceHook({ hook_event_name: 'UserPromptSubmit', prompt: 'h:local local-debug quality', cwd: projectRoot, session_id: 'local-source-session' }, { bindingsDir });
  assert.equal(malformed.decision, 'block');
  assert.deepEqual(await handleLocalSourceHook({ hook_event_name: 'UserPromptSubmit', prompt: 'h:local-debug quality fixture-v1', cwd: projectRoot, session_id: 'local-source-session' }, { bindingsDir }), {});
  assert.deepEqual(await handleLocalSourceHook({ hook_event_name: 'UserPromptSubmit', prompt: 'ordinary request', cwd: projectRoot, session_id: 'local-source-session' }, { bindingsDir }), {});

  const output = new PassThrough();
  const probe = runLocalSourceHostProbe({ bindingsDir, sessionId: 'local-source-session', output, responseTimeoutMs: 1000, transport: 'hook' });
  const [chunk] = await once(output, 'data');
  const request = JSON.parse(chunk.toString());
  assert.equal(request.tool, 'collaboration.list_agents');
  assert.deepEqual(request.arguments, {});
  assert.deepEqual(await handleLocalSourceHook({ hook_event_name: 'PostToolUse', tool_name: 'list_agents', tool_use_id: 'native-tool-local-source', tool_input: {}, tool_response: { agents: [] }, session_id: 'local-source-session', turn_id: 'local-source-turn' }, { bindingsDir }), {});
  const result = await probe;
  assert.equal(result.ok, true);
  assert.equal(result.requestId, request.requestId);
  assert.equal(result.agentCount, 0);

  const staleManifest = JSON.parse(await readFile(source.file, 'utf8'));
  const changedPath = 'integrations/codex/agent-harness-codex/hooks/local-source-hook.mjs';
  staleManifest.files.find(item => item.path === changedPath).sha256 = '0'.repeat(64);
  staleManifest.sourceIdentity.runtimeFiles.find(item => item.path === changedPath).sha256 = '0'.repeat(64);
  staleManifest.sourceIdentity.runtimeDigest = digestJson(staleManifest.sourceIdentity.runtimeFiles);
  staleManifest.sourceIdentity.sourceDigest = digestJson(staleManifest.files);
  staleManifest.release.artifactDigest = staleManifest.sourceIdentity.runtimeDigest;
  const unsigned = { ...staleManifest };
  delete unsigned.manifestDigest;
  staleManifest.manifestDigest = digestJson(unsigned);
  await writeFile(source.file, JSON.stringify(staleManifest));
  const staleBinding = JSON.parse(await readFile(configured.bindingFile, 'utf8'));
  staleBinding.harness.release.artifactDigest = staleManifest.release.artifactDigest;
  await writeFile(configured.bindingFile, JSON.stringify(staleBinding));
  const staleResponse = await handleLocalSourceHook({ hook_event_name: 'UserPromptSubmit', prompt: 'h:local local-debug quality fixture-v1', cwd: projectRoot, session_id: 'local-source-session' }, { bindingsDir });
  assert.equal(staleResponse.decision, 'block');
  assert.match(staleResponse.reason, /LOCAL_SOURCE_HOOK_CWD_MISMATCH/);
  assert.doesNotMatch(staleResponse.reason, /coordinationIntent/);

  const previousCwd = process.cwd();
  let synced;
  try {
    process.chdir(projectRoot);
    synced = await handleLocalSourceHook({ hook_event_name: 'UserPromptSubmit', prompt: 'h:local local-debug quality fixture-v1', cwd: projectRoot, session_id: 'local-source-session' }, { bindingsDir });
  } finally { process.chdir(previousCwd); }
  assert.match(synced.hookSpecificOutput.additionalContext, /已自动同步（H3/);
  const syncedIntent = JSON.parse(synced.hookSpecificOutput.additionalContext.split('解析结果：').at(-1));
  assert.equal(decodeVisibleLifecycleIntent(syncedIntent.coordinationIntent).command.target, 'fixture-v1');
  assert.notEqual(JSON.parse(await readFile(source.file, 'utf8')).release.artifactDigest, staleManifest.release.artifactDigest);

  const mismatchedBinding = JSON.parse(await readFile(configured.bindingFile, 'utf8'));
  mismatchedBinding.harness.release.artifactDigest = '0'.repeat(64);
  await writeFile(configured.bindingFile, JSON.stringify(mismatchedBinding));
  let rebound;
  try {
    process.chdir(projectRoot);
    rebound = await handleLocalSourceHook({ hook_event_name: 'UserPromptSubmit', prompt: 'h:local local-debug quality fixture-v1', cwd: projectRoot, session_id: 'local-source-session' }, { bindingsDir });
  } finally { process.chdir(previousCwd); }
  assert.match(rebound.hookSpecificOutput.additionalContext, /已自动同步（无源码差异/);
  assert.match(rebound.hookSpecificOutput.additionalContext, /coordinationIntent/);

  const h4Manifest = JSON.parse(await readFile(source.file, 'utf8'));
  const h4Path = 'src/kernel/kernel.mjs';
  h4Manifest.files.find(item => item.path === h4Path).sha256 = '0'.repeat(64);
  h4Manifest.sourceIdentity.runtimeFiles.find(item => item.path === h4Path).sha256 = '0'.repeat(64);
  h4Manifest.sourceIdentity.runtimeDigest = digestJson(h4Manifest.sourceIdentity.runtimeFiles);
  h4Manifest.sourceIdentity.sourceDigest = digestJson(h4Manifest.files);
  h4Manifest.release.artifactDigest = h4Manifest.sourceIdentity.runtimeDigest;
  const h4Unsigned = { ...h4Manifest };
  delete h4Unsigned.manifestDigest;
  h4Manifest.manifestDigest = digestJson(h4Unsigned);
  await writeFile(source.file, JSON.stringify(h4Manifest));
  const h4Binding = JSON.parse(await readFile(configured.bindingFile, 'utf8'));
  h4Binding.harness.release.artifactDigest = h4Manifest.release.artifactDigest;
  await writeFile(configured.bindingFile, JSON.stringify(h4Binding));
  let h4Response;
  try {
    process.chdir(projectRoot);
    h4Response = await handleLocalSourceHook({ hook_event_name: 'UserPromptSubmit', prompt: 'h:local local-debug quality fixture-v1', cwd: projectRoot, session_id: 'local-source-session' }, { bindingsDir });
  } finally { process.chdir(previousCwd); }
  assert.equal(h4Response.decision, 'block');
  assert.match(h4Response.reason, /H4，不能自动同步/);
  assert.match(h4Response.reason, /review-migration-or-release-plan/);
  assert.doesNotMatch(h4Response.reason, /coordinationIntent/);
  assert.equal(JSON.parse(await readFile(source.file, 'utf8')).manifestDigest, h4Manifest.manifestDigest);
});
