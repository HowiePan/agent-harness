#!/usr/bin/env node
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capturePostToolUse } from './post-tool-host-bridge.mjs';
import { hookResponse, loadBindings } from './pseudo-command-router.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const samePath = (left, right) => process.platform === 'win32' ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);
const inside = (parent, child) => { const path = relative(parent, child); return path === '' || (!path.startsWith('..') && !isAbsolute(path)); };

export const loadLocalSourceBindings = async bindingsDir => {
  if (!isAbsolute(bindingsDir ?? '')) fail('LOCAL_SOURCE_HOOK_BINDINGS_REQUIRED', 'Local source Hook requires an absolute bindings directory.');
  const pluginData = resolve(bindingsDir);
  const bindingOptions = { pluginData, pluginRoot: null, fallbackPluginRoot: null };
  const bindings = await loadBindings(bindingOptions);
  if (bindings.harness.release.mode !== 'source-link' || !bindings.harness.release.developmentManifest) fail('LOCAL_SOURCE_HOOK_DEVELOPMENT_REQUIRED', 'Local source Hook requires a verified source-link binding.');
  const integrationRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (!inside(bindings.harness.controlRoot, pluginData) || !samePath(bindings.harness.coordinatorEntrypoint, resolve(integrationRoot, 'scripts', 'visible-lifecycle-coordinator.mjs')) || !samePath(bindings.harness.hostBridgeModule, resolve(integrationRoot, 'lib', 'hook-host-exchange.mjs'))) fail('LOCAL_SOURCE_HOOK_IDENTITY_MISMATCH', 'Local Hook and verified source-link binding refer to different source or control roots.');
  return { bindings, bindingOptions, integrationRoot };
};

export const renderLocalSourceHooks = async ({ bindingsDir } = {}) => {
  await loadLocalSourceBindings(bindingsDir);
  const paths = [process.execPath, fileURLToPath(import.meta.url), '--bindings-dir', resolve(bindingsDir)];
  const quote = value => process.platform === 'win32' ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`;
  const command = paths.map(quote).join(' ');
  const handler = { type: 'command', command, ...(process.platform === 'win32' ? { commandWindows: command } : {}), timeout: 15 };
  return { description: 'Agent Harness source-link local development Host bridge.', hooks: {
    PostToolUse: [{ matcher: '^(Agent|(collaboration\\.)?(spawn_agent|list_agents|wait_agent|interrupt_agent))$', hooks: [handler] }],
    UserPromptSubmit: [{ hooks: [{ ...handler, timeout: 5, additionalContextLimit: 1200 }] }],
  } };
};

export const handleLocalSourceHook = async (event, { bindingsDir } = {}) => {
  const { bindings, bindingOptions, integrationRoot } = await loadLocalSourceBindings(bindingsDir);
  if (event?.hook_event_name === 'PostToolUse') {
    await capturePostToolUse(event, { ...bindingOptions, bindings });
    return {};
  }
  if (event?.hook_event_name === 'UserPromptSubmit') {
    if (event?.prompt?.trim() === 'h:probe') {
      if (typeof event.session_id !== 'string' || !event.session_id.length) fail('LOCAL_SOURCE_HOOK_SESSION_REQUIRED', 'Local Host probe requires the current Codex session ID from UserPromptSubmit.');
      const probe = resolve(integrationRoot, 'scripts', 'local-source-host-probe.mjs');
      return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `这是本地源码 Host 只读短探针，不创建 Run。当前 Hook 已验证绑定。通过可观察的长驻终端进程运行 ${probe}，参数数组为 ${JSON.stringify(['--bindings-dir', resolve(bindingsDir), '--session-id', event.session_id])}。进程发出 codex-visible-host-request 后，只调用一次请求中的原生 collaboration.list_agents，使用精确 arguments；PostToolUse Hook 必须自动回传结果，不得手写响应。保持同一终端 session 并等待探针完成；报告 requestId、结果码和 Hook 阶段。若缺少原生工具或超时，停止于 attention-required，不启动质量 Run。` } };
    }
    const response = await hookResponse(event, bindingOptions);
    if (!response?.hookSpecificOutput?.additionalContext) return response ?? {};
    const commandSkill = resolve(integrationRoot, 'skills', 'agent-harness-command', 'SKILL.md');
    const operatorSkill = resolve(integrationRoot, 'skills', 'agent-harness-operator', 'SKILL.md');
    const additionalContext = response.hookSpecificOutput.additionalContext
      .replaceAll('$agent-harness-command', `必须读取并遵循本地源码适配说明 ${commandSkill}`)
      .replaceAll('$agent-harness-operator', `必须读取并遵循本地源码操作说明 ${operatorSkill}`);
    return { ...response, hookSpecificOutput: { ...response.hookSpecificOutput, additionalContext } };
  }
  fail('LOCAL_SOURCE_HOOK_EVENT_UNSUPPORTED', 'Local source Hook accepts only PostToolUse and UserPromptSubmit.');
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
