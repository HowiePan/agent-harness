#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncDevelopmentSource } from '../../../../src/interfaces/cli/local-development-sync.mjs';
import { classifyLocalIncident } from '../../../../src/application/local-incident.mjs';
import { capturePostToolUse } from './post-tool-host-bridge.mjs';
import { hookResponse, loadBindings, parsePseudoCommand } from './pseudo-command-router.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const samePath = (left, right) => process.platform === 'win32' ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
const inside = (parent, child) => { const path = relative(parent, child); return path === '' || (!path.startsWith('..') && !isAbsolute(path)); };
const integrationRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(integrationRoot, '..', '..', '..');
const staleBindingCodes = new Set(['HARNESS_SOURCE_IDENTITY_CHANGED', 'SOURCE_LINK_RELEASE_STALE']);
const blockLocalCommand = (code, detail) => {
  const incident = classifyLocalIncident({ error: code, phase: 'hook' });
  return {
    decision: 'block',
    reason: `Agent Harness 本地命令已阻断（${code}，${incident.severity}，${incident.severityStatus}）：${detail} 处置：${incident.disposition}；后续：${incident.continuation}。先核查本地绑定与故障证据；确认为 Harness 缺陷后在独立 Harness 维护上下文修复，并按 H0–H4 判定补丁对 Run 的影响；不得改由普通对话或仓库脚本执行。故障 ID：${incident.incidentId}`,
  };
};
const bindingFailureContext = error => {
  const code = error?.code ?? 'LOCAL_SOURCE_BINDING_UNAVAILABLE';
  const stale = staleBindingCodes.has(code);
  const detail = stale
    ? `本地 source-link 绑定已过期（${code}）。请从已绑定的项目 checkout 运行 agent-harness dev sync --manifest <development-manifest>，同步成功后重新发送本地命令。`
    : `本地 source-link 绑定校验失败（${code}）。请检查项目 Hook 和绑定配置。`;
  return blockLocalCommand(code, detail);
};

const syncLocalSourceBinding = async ({ event, parsed, bindingsDir, forceRebind }) => {
  const cwd = resolve(process.cwd());
  if (!event?.cwd || !samePath(event.cwd, cwd)) fail('LOCAL_SOURCE_HOOK_CWD_MISMATCH', 'Local Hook process and submitted project checkout differ.');
  if (!isAbsolute(bindingsDir ?? '')) fail('LOCAL_SOURCE_HOOK_BINDINGS_REQUIRED', 'Local Hook requires an absolute bindings directory.');
  const declared = JSON.parse(await readFile(resolve(bindingsDir, 'bindings.json'), 'utf8'));
  const harness = declared?.harness;
  const manifestFile = harness?.release?.developmentManifest;
  const entrypoint = resolve(sourceRoot, 'bin', 'agent-harness.mjs');
  if (harness?.release?.mode !== 'source-link' || !isAbsolute(harness?.controlRoot ?? '') || !samePath(harness.controlRoot, sourceRoot)
    || !isAbsolute(harness?.dataRoot ?? '') || !inside(sourceRoot, harness.dataRoot) || !inside(harness.dataRoot, bindingsDir)
    || !isAbsolute(harness?.entrypoint ?? '') || !samePath(harness.entrypoint, entrypoint)
    || !isAbsolute(manifestFile ?? '') || !inside(harness.dataRoot, manifestFile)) fail('LOCAL_SOURCE_AUTO_SYNC_BINDING_MISMATCH', 'Local Hook binding does not identify this exact Harness source and control root.');
  const aliases = Object.keys({ ...declared.projects, ...declared.workspaces });
  const alias = parsed.projectAlias ?? (aliases.length === 1 ? aliases[0] : null);
  const project = declared.projects?.[alias] ?? declared.workspaces?.[alias];
  if (!alias || !project || !isAbsolute(project.workspaceRoot ?? '') || !samePath(project.workspaceRoot, cwd)) fail('LOCAL_SOURCE_AUTO_SYNC_PROJECT_MISMATCH', 'Automatic sync requires the selected alias in its exact registered project checkout.');
  const result = await syncDevelopmentSource(manifestFile, { forceRebind, cwd });
  return { level: result.receipt?.level ?? null, receiptFile: result.receiptFile ?? null, continuation: result.continuation };
};

const autoSyncFailureContext = error => {
  const code = error?.code ?? 'LOCAL_SOURCE_AUTO_SYNC_FAILED';
  const detail = code === 'DEVELOPMENT_PATCH_INCOMPATIBLE'
    ? '源码变更为 H4，不能自动同步；需要显式迁移或新 Release。'
    : '本地源码自动同步未完成。请检查项目 checkout、绑定和同步诊断。';
  return blockLocalCommand(code, detail);
};

const verifiedCommandResponse = (response, parsed) => {
  const context = response?.hookSpecificOutput?.additionalContext;
  const marker = '解析结果：';
  let intent;
  try { intent = JSON.parse(context.slice(context.lastIndexOf(marker) + marker.length)); }
  catch { return false; }
  return context.includes(marker)
    && intent?.projectAlias === parsed.projectAlias
    && intent?.action === parsed.action
    && intent?.target === parsed.target
    && typeof intent.coordinationIntent === 'string'
    && typeof intent.coordinationIntentDigest === 'string';
};

export const loadLocalSourceBindings = async bindingsDir => {
  if (!isAbsolute(bindingsDir ?? '')) fail('LOCAL_SOURCE_HOOK_BINDINGS_REQUIRED', 'Local source Hook requires an absolute bindings directory.');
  const pluginData = resolve(bindingsDir);
  const bindingOptions = { pluginData, pluginRoot: null, fallbackPluginRoot: null };
  const bindings = await loadBindings(bindingOptions);
  if (bindings.harness.release.mode !== 'source-link' || !bindings.harness.release.developmentManifest) fail('LOCAL_SOURCE_HOOK_DEVELOPMENT_REQUIRED', 'Local source Hook requires a verified source-link binding.');
  if (!inside(bindings.harness.controlRoot, pluginData) || !samePath(bindings.harness.coordinatorEntrypoint, resolve(integrationRoot, 'scripts', 'visible-lifecycle-coordinator.mjs')) || !samePath(bindings.harness.hostBridgeModule, resolve(integrationRoot, 'lib', 'hook-host-exchange.mjs'))) fail('LOCAL_SOURCE_HOOK_IDENTITY_MISMATCH', 'Local Hook and verified source-link binding refer to different source or control roots.');
  return { bindings, bindingOptions, integrationRoot };
};

export const renderLocalSourceHooks = async ({ bindingsDir } = {}) => {
  await loadLocalSourceBindings(bindingsDir);
  const paths = [process.execPath, fileURLToPath(import.meta.url), '--bindings-dir', resolve(bindingsDir)];
  const quote = value => process.platform === 'win32' ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`;
  const command = paths.map(quote).join(' ');
  const handler = { type: 'command', command, ...(process.platform === 'win32' ? { commandWindows: command } : {}), timeout: 120 };
  return { description: 'Agent Harness source-link local command router.', hooks: {
    UserPromptSubmit: [{ hooks: [handler] }],
  } };
};

export const handleLocalSourceHook = async (event, { bindingsDir } = {}) => {
  if (event?.hook_event_name === 'UserPromptSubmit') {
    if (typeof event.prompt !== 'string' || !/^h:local(?:\s|$)/.test(event.prompt)) return {};
    const match = event.prompt.match(/^h:local\s+(.+)$/);
    if (!match) return blockLocalCommand('LOCAL_SOURCE_COMMAND_INVALID', '命令语法为 h:local <项目别名> <动作> <目标> [预设]。');
    if (match[1].startsWith('init ')) return blockLocalCommand('LOCAL_SOURCE_INITIALIZATION_REQUIRED', '首次本地绑定请从项目 checkout 运行 agent-harness dev execute。');
    const prompt = `h:${match[1]}`;
    const parsed = parsePseudoCommand(prompt);
    if (!parsed || parsed.kind === 'invalid') return blockLocalCommand('LOCAL_SOURCE_COMMAND_INVALID', parsed?.error ?? '无法解析本地命令。');
    let bindingOptions;
    let synchronized = null;
    try { ({ bindingOptions } = await loadLocalSourceBindings(bindingsDir)); }
    catch (error) {
      if (!staleBindingCodes.has(error?.code)) return bindingFailureContext(error);
      try { synchronized = await syncLocalSourceBinding({ event, parsed, bindingsDir, forceRebind: error.code === 'SOURCE_LINK_RELEASE_STALE' }); }
      catch (syncError) { return autoSyncFailureContext(syncError); }
      try { ({ bindingOptions } = await loadLocalSourceBindings(bindingsDir)); }
      catch (retryError) { return bindingFailureContext(retryError); }
    }
    let response;
    try { response = await hookResponse({ ...event, prompt }, bindingOptions) ?? {}; }
    catch (error) { return blockLocalCommand(error?.code ?? 'LOCAL_SOURCE_ROUTING_FAILED', '命令意图生成失败。'); }
    if (parsed.kind === 'command' && !verifiedCommandResponse(response, parsed)) return blockLocalCommand('LOCAL_SOURCE_COMMAND_INTENT_MISSING', '没有取得与项目、动作和目标一致的可信 Coordinator 意图。');
    if (synchronized && response.hookSpecificOutput?.additionalContext) response.hookSpecificOutput.additionalContext = `本地 source-link 已自动同步（${synchronized.level ?? '无源码差异'}；${synchronized.continuation ?? '已更新绑定'}）。${response.hookSpecificOutput.additionalContext}`;
    return response;
  }
  if (event?.hook_event_name === 'PostToolUse') {
    const { bindings, bindingOptions } = await loadLocalSourceBindings(bindingsDir);
    await capturePostToolUse(event, { ...bindingOptions, bindings });
    return {};
  }
  fail('LOCAL_SOURCE_HOOK_EVENT_UNSUPPORTED', 'Local source Hook accepts only UserPromptSubmit or PostToolUse.');
};

const main = async () => {
  if (process.argv.length !== 4 || !['--bindings-dir', '--print-config'].includes(process.argv[2])) fail('LOCAL_SOURCE_HOOK_ARGUMENTS_INVALID', 'Usage: local-source-hook.mjs --bindings-dir|--print-config <absolute-dir>');
  if (process.argv[2] === '--print-config') {
    process.stdout.write(`${JSON.stringify(await renderLocalSourceHooks({ bindingsDir: process.argv[3] }), null, 2)}\n`);
    return;
  }
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  process.stdout.write(JSON.stringify(await handleLocalSourceHook(JSON.parse(raw), { bindingsDir: process.argv[3] })));
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`Agent Harness local source Hook failed: ${error.code ?? 'UNEXPECTED_ERROR'} ${error.message}\n`);
    process.exitCode = 1;
  });
}
