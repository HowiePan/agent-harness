import { lstat, readFile, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { validateActiveReleaseBinding } from '../lib/active-release-binding.mjs';
import { createVisibleLifecycleIntent, encodeVisibleLifecycleIntent } from '../lib/visible-lifecycle-intent.mjs';

const tokenPattern = /^[a-z][a-z0-9-]{0,31}$/;
const commandPattern = /^h:([^\s]+)(?:\s+(.+))?$/;
const modulePluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const inside = (parent, child) => {
  const path = relative(resolve(parent), resolve(child));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
};

const samePath = (left, right) => process.platform === 'win32'
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
  : resolve(left) === resolve(right);

const optionalLstat = async path => {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

export const resolveGitWorkspaceIdentity = async workspaceRoot => {
  const root = resolve(workspaceRoot);
  const marker = resolve(root, '.git');
  const markerInfo = await optionalLstat(marker);
  if (!markerInfo) return null;
  let gitDirectory;
  if (markerInfo.isDirectory()) gitDirectory = marker;
  else {
    if (!markerInfo.isFile()) throw new Error(`workspace .git 不是文件或目录：${marker}`);
    const match = (await readFile(marker, 'utf8')).trim().match(/^gitdir:\s*(.+)$/i);
    if (!match?.[1]) throw new Error(`workspace .git 未声明 gitdir：${marker}`);
    gitDirectory = resolve(root, match[1]);
    if (!(await optionalLstat(gitDirectory))?.isDirectory()) throw new Error(`workspace gitdir 不存在：${gitDirectory}`);
  }
  let commonDirectory = gitDirectory;
  try {
    const common = (await readFile(resolve(gitDirectory, 'commondir'), 'utf8')).trim();
    if (!common) throw new Error(`workspace commondir 为空：${gitDirectory}`);
    commonDirectory = resolve(gitDirectory, common);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return Object.freeze({ type: 'git-common-dir', commonDir: await realpath(commonDirectory) });
};

export const parsePseudoCommand = prompt => {
  if (typeof prompt !== 'string' || !prompt.startsWith('h:')) return null;
  if (prompt.length > 512 || /[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(prompt)) return { kind: 'invalid', error: '伪命令必须是最长 512 字符的单行文本。' };
  const match = prompt.trim().match(commandPattern);
  if (!match || !tokenPattern.test(match[1])) return { kind: 'invalid', error: '语法应为 h:<项目别名> <动作> <目标> [预设]、h:where，或 h:report <项目别名>。' };
  const tokens = (match[2] ?? '').trim().split(/\s+/).filter(Boolean);
  if (match[1] === 'where') {
    if (tokens.length > 1 || (tokens[0] && !tokenPattern.test(tokens[0]))) return { kind: 'invalid', error: 'h:where 只接受一个可选项目别名。' };
    return { protocolVersion: '1.0', kind: 'where', ...(tokens[0] ? { projectAlias: tokens[0] } : {}) };
  }
  if (match[1] === 'report') {
    if (tokens.length !== 1 || !tokenPattern.test(tokens[0])) return { kind: 'invalid', error: 'h:report 只接受一个项目别名。' };
    return { protocolVersion: '1.0', kind: 'report', projectAlias: tokens[0] };
  }
  if (tokens.length < 2 || tokens.length > 3 || !tokenPattern.test(tokens[0])) return { kind: 'invalid', error: '语法应为 h:<项目别名> <动作> <目标> [预设]；项目和动作必须显式给出。' };
  return {
    protocolVersion: '1.0',
    kind: 'command',
    projectAlias: match[1],
    action: tokens[0],
    target: tokens[1],
    arguments: tokens.slice(2),
  };
};

const validateBindings = async (input, source) => {
  if (input?.protocolVersion !== '1.0') throw new Error(`绑定文件版本无效：${source}`);
  const harness = input.harness;
  if (!harness || !isAbsolute(harness.controlRoot ?? '') || !isAbsolute(harness.entrypoint ?? '') || !isAbsolute(harness.dataRoot ?? '')) throw new Error(`绑定文件必须声明绝对 controlRoot、entrypoint 和 dataRoot：${source}`);
  if (!inside(harness.controlRoot, harness.entrypoint) || !inside(harness.controlRoot, harness.dataRoot)) throw new Error(`entrypoint 和 dataRoot 必须位于 controlRoot 内：${source}`);
  if (!input.projects || typeof input.projects !== 'object' || Array.isArray(input.projects) || Object.keys(input.projects).length === 0) throw new Error(`绑定文件至少需要一个项目别名：${source}`);
  const activeRelease = await validateActiveReleaseBinding({ controlRoot: harness.controlRoot, dataRoot: harness.dataRoot, entrypoint: harness.entrypoint, declaredRelease: harness.release });
  const release = { version: activeRelease.version, artifactDigest: activeRelease.artifactDigest, generationId: activeRelease.generationId, pointerDigest: activeRelease.pointerDigest };
  const projects = {};
  for (const [alias, project] of Object.entries(input.projects)) {
    if (!tokenPattern.test(alias) || !project?.projectId || !project.profileId || !project.extensionId) throw new Error(`项目绑定无效：${alias}`);
    const workspaceRoot = isAbsolute(project.workspaceRoot ?? '') ? resolve(project.workspaceRoot) : null;
    if (!workspaceRoot) throw new Error(`项目绑定必须声明绝对 workspaceRoot：${alias}`);
    const discoveredWorkspaceIdentity = await resolveGitWorkspaceIdentity(workspaceRoot);
    const declaredIdentity = project.workspaceIdentity;
    if (declaredIdentity !== undefined) {
      if (declaredIdentity?.type !== 'git-common-dir' || !isAbsolute(declaredIdentity.commonDir ?? '')) throw new Error(`workspaceIdentity 无效：${alias}`);
      if (!discoveredWorkspaceIdentity || !samePath(declaredIdentity.commonDir, discoveredWorkspaceIdentity.commonDir)) throw new Error(`workspaceIdentity 与 workspaceRoot 不匹配：${alias}`);
    }
    projects[alias] = { projectId: String(project.projectId), profileId: String(project.profileId), extensionId: String(project.extensionId), workspaceRoot, workspaceIdentity: declaredIdentity ? { type: 'git-common-dir', commonDir: resolve(declaredIdentity.commonDir) } : discoveredWorkspaceIdentity };
  }
  return Object.freeze({
    protocolVersion: '1.0',
    source,
    harness: Object.freeze({ controlRoot: resolve(harness.controlRoot), entrypoint: resolve(harness.entrypoint), coordinatorEntrypoint: activeRelease.coordinatorEntrypoint, dataRoot: resolve(harness.dataRoot), release }),
    projects: Object.freeze(projects),
  });
};

export const loadBindings = async ({ pluginData = process.env.PLUGIN_DATA, pluginRoot = process.env.PLUGIN_ROOT, fallbackPluginRoot = modulePluginRoot } = {}) => {
  // Codex normally injects both variables. After a desktop restart, some Hook
  // launches have resolved the command path but omitted the variables from the
  // child environment. Derive only this module's own install root as a bounded
  // fallback; never scan parent directories or search the filesystem.
  const pluginRoots = [...new Set([pluginRoot, fallbackPluginRoot].filter(Boolean))];
  const candidates = [
    ...(pluginData ? [resolve(pluginData, 'bindings.json')] : []),
    ...pluginRoots.map(root => resolve(root, '.plugin-data', 'bindings.json')),
  ];
  for (const file of [...new Set(candidates)]) {
    try { return await validateBindings(JSON.parse(await readFile(file, 'utf8')), file); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
  }
  throw new Error('插件尚未配置绑定。请在安装时写入 PLUGIN_DATA/bindings.json；禁止扫描磁盘寻找 Agent Harness。');
};

const matchWorkspace = async (project, cwd) => {
  if (inside(project.workspaceRoot, cwd)) return Object.freeze({ kind: 'bound-root', executionWorkspaceRoot: project.workspaceRoot, workspaceIdentity: project.workspaceIdentity });
  if (!project.workspaceIdentity) return null;
  const identity = await resolveGitWorkspaceIdentity(cwd);
  if (!identity || !samePath(identity.commonDir, project.workspaceIdentity.commonDir)) return null;
  return Object.freeze({ kind: 'linked-worktree', executionWorkspaceRoot: cwd, workspaceIdentity: identity });
};

const contextResponse = additionalContext => ({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } });

export const hookResponse = async (input, options = {}) => {
  const parsed = parsePseudoCommand(input?.prompt);
  if (!parsed) return null;
  if (parsed.kind === 'invalid') return contextResponse(`Agent Harness 伪命令解析失败：${parsed.error} 不得启动或修改任何 Harness 状态。`);
  let bindings;
  try { bindings = await loadBindings(options); }
  catch (error) { return contextResponse(`Agent Harness 绑定不可用：${error.message} 不得搜索磁盘，不得启动或修改任何 Harness 状态。`); }
  const cwd = resolve(input?.cwd ?? '.');

  if (parsed.kind === 'where') {
    const projects = parsed.projectAlias ? { [parsed.projectAlias]: bindings.projects[parsed.projectAlias] } : bindings.projects;
    if (parsed.projectAlias && !projects[parsed.projectAlias]) return contextResponse(`Agent Harness 项目别名不存在：${parsed.projectAlias}。可用别名：${Object.keys(bindings.projects).join(', ')}。这是只读查询，不得启动 Harness。`);
    const matches = {};
    for (const [alias, project] of Object.entries(projects)) {
      try {
        const workspace = await matchWorkspace(project, cwd);
        matches[alias] = workspace ? { executionWorkspaceRoot: workspace.executionWorkspaceRoot, workspaceMatch: workspace.kind } : null;
      } catch (error) { matches[alias] = { error: error.message }; }
    }
    const view = { harness: bindings.harness, projects, matches, bindingSource: bindings.source };
    return contextResponse(`这是 h:where 的只读结果。向用户清晰展示以下已配置绑定，不得扫描磁盘、创建 Run、运行 Gate 或写入 Authority：${JSON.stringify(view)}`);
  }

  const project = bindings.projects[parsed.projectAlias];
  if (!project) return contextResponse(`Agent Harness 项目别名不存在：${parsed.projectAlias}。可用别名：${Object.keys(bindings.projects).join(', ')}。不得猜测项目或搜索磁盘。`);
  let workspace;
  try { workspace = await matchWorkspace(project, cwd); }
  catch (error) { return contextResponse(`Agent Harness workspace 身份验证失败：${error.message}。不得启动 Harness。`); }
  if (!workspace) return contextResponse(`Agent Harness 命令拒绝：当前 cwd ${cwd} 既不在项目 ${parsed.projectAlias} 的 workspaceRoot ${project.workspaceRoot} 内，也不是该仓库经验证的 linked worktree。不得搜索其他项目或启动 Harness。`);

  if (parsed.kind === 'report') {
    const reportHarness = { controlRoot: bindings.harness.controlRoot, entrypoint: bindings.harness.entrypoint, dataRoot: bindings.harness.dataRoot, release: bindings.harness.release };
    const report = { ...parsed, project, harness: reportHarness, workspaceRoot: project.workspaceRoot, workspaceIdentity: project.workspaceIdentity, executionWorkspaceRoot: workspace.executionWorkspaceRoot, workspaceMatch: workspace.kind, cwd, commandId: `report_${randomUUID()}` };
    return contextResponse(`检测到 h:report。使用 $agent-harness-command 在当前任务采集并脱敏相关对话；缺失证据列入 missingEvidence，不得伪造。通过绑定 entrypoint 以 stdin 调用 issue record；只写 controlRoot/issues。不得新建任务、运行 Harness、接受其他输出目录或提交 Git。返回 issue ID、路径和未提交状态。解析结果：${JSON.stringify(report)}`);
  }

  const coordinationIntent = createVisibleLifecycleIntent({
    harness: bindings.harness,
    project,
    command: parsed,
    executionWorkspaceRoot: workspace.executionWorkspaceRoot,
    coordinatorEntrypoint: bindings.harness.coordinatorEntrypoint,
  });
  const intent = { ...parsed, project, harness: bindings.harness, workspaceRoot: project.workspaceRoot, workspaceIdentity: project.workspaceIdentity, executionWorkspaceRoot: workspace.executionWorkspaceRoot, workspaceMatch: workspace.kind, cwd, commandId: coordinationIntent.commandId, coordinationIntent: encodeVisibleLifecycleIntent(coordinationIntent), coordinationIntentDigest: coordinationIntent.intentDigest };
  return contextResponse(`检测到 Agent Harness 伪命令。所有面向用户的控制对话使用中文；协议 JSON、命令、路径与错误码保持原样，且不得翻译或改写子 Agent Prompt。把它作为确定性的 Command Intent，而不是自由提示词；动作和预设仍由已绑定 Extension 的 commandManifest 解析。使用 $agent-harness-command；启动任何进程前先确认当前任务同时提供 collaboration.spawn_agent/list_agents/wait_agent/interrupt_agent。缺任一项即以 CODEX_MULTI_AGENT_V2_REQUIRED 停止，并提示执行 codex features enable multi_agent_v2 后新建任务；multi_agent_v1 或其他任务接口不得替代。能力满足后，只使用已绑定的 coordinatorEntrypoint，并把 coordinationIntent 作为 --intent 的单一参数；当前 Windows Codex 长驻通道使用 tty:true 并在启动前把控制台宽度设为至少 4096 列，非 PTY 通道会关闭 stdin。必须解析请求对象并原样使用 arguments，禁止从视觉换行文本抄写字段。逐项原样执行它请求的 collaboration 工具，原样回传工具结果；不得自行构造 Host 响应。不得根据目标格式猜项目，不得搜索磁盘，不得把参数当作 shell。解析结果：${JSON.stringify(intent)}`);
};

const main = async () => {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const response = await hookResponse(JSON.parse(raw));
  if (response) process.stdout.write(JSON.stringify(response));
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`Agent Harness pseudo-command hook failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
