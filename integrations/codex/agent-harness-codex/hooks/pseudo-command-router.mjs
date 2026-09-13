import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const tokenPattern = /^[a-z][a-z0-9-]{0,31}$/;
const commandPattern = /^h:([^\s]+)(?:\s+(.+))?$/;

const inside = (parent, child) => {
  const path = relative(resolve(parent), resolve(child));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
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

const validateBindings = (input, source) => {
  if (input?.protocolVersion !== '1.0') throw new Error(`绑定文件版本无效：${source}`);
  const harness = input.harness;
  if (!harness || !isAbsolute(harness.controlRoot ?? '') || !isAbsolute(harness.entrypoint ?? '') || !isAbsolute(harness.dataRoot ?? '')) throw new Error(`绑定文件必须声明绝对 controlRoot、entrypoint 和 dataRoot：${source}`);
  if (!inside(harness.controlRoot, harness.entrypoint) || !inside(harness.controlRoot, harness.dataRoot)) throw new Error(`entrypoint 和 dataRoot 必须位于 controlRoot 内：${source}`);
  if (!isAbsolute(input.workspaceRoot ?? '')) throw new Error(`绑定文件必须声明绝对 workspaceRoot：${source}`);
  if (!input.projects || typeof input.projects !== 'object' || Array.isArray(input.projects) || Object.keys(input.projects).length === 0) throw new Error(`绑定文件至少需要一个项目别名：${source}`);
  const projects = {};
  for (const [alias, project] of Object.entries(input.projects)) {
    if (!tokenPattern.test(alias) || !project?.projectId || !project.profileId || !project.extensionId) throw new Error(`项目绑定无效：${alias}`);
    projects[alias] = { projectId: String(project.projectId), profileId: String(project.profileId), extensionId: String(project.extensionId) };
  }
  return Object.freeze({
    protocolVersion: '1.0',
    source,
    harness: Object.freeze({ controlRoot: resolve(harness.controlRoot), entrypoint: resolve(harness.entrypoint), dataRoot: resolve(harness.dataRoot) }),
    workspaceRoot: resolve(input.workspaceRoot),
    projects: Object.freeze(projects),
  });
};

export const loadBindings = async ({ pluginData = process.env.PLUGIN_DATA, pluginRoot = process.env.PLUGIN_ROOT } = {}) => {
  const candidates = [
    ...(pluginData ? [resolve(pluginData, 'bindings.json')] : []),
    ...(pluginRoot ? [resolve(pluginRoot, '.plugin-data', 'bindings.json')] : []),
  ];
  for (const file of [...new Set(candidates)]) {
    try { return validateBindings(JSON.parse(await readFile(file, 'utf8')), file); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
  }
  throw new Error('插件尚未配置绑定。请在安装时写入 PLUGIN_DATA/bindings.json；禁止扫描磁盘寻找 Agent Harness。');
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
  if (!inside(bindings.workspaceRoot, cwd)) return contextResponse(`Agent Harness 命令拒绝：当前 cwd ${cwd} 不在已绑定 workspaceRoot ${bindings.workspaceRoot} 内。不得搜索其他项目或启动 Harness。`);

  if (parsed.kind === 'where') {
    const projects = parsed.projectAlias ? { [parsed.projectAlias]: bindings.projects[parsed.projectAlias] } : bindings.projects;
    if (parsed.projectAlias && !projects[parsed.projectAlias]) return contextResponse(`Agent Harness 项目别名不存在：${parsed.projectAlias}。可用别名：${Object.keys(bindings.projects).join(', ')}。这是只读查询，不得启动 Harness。`);
    const view = { harness: bindings.harness, workspaceRoot: bindings.workspaceRoot, projects, bindingSource: bindings.source };
    return contextResponse(`这是 h:where 的只读结果。向用户清晰展示以下已配置绑定，不得扫描磁盘、创建 Run、运行 Gate 或写入 Authority：${JSON.stringify(view)}`);
  }

  if (parsed.kind === 'report') {
    const project = bindings.projects[parsed.projectAlias];
    if (!project) return contextResponse(`Agent Harness 项目别名不存在：${parsed.projectAlias}。可用别名：${Object.keys(bindings.projects).join(', ')}。不得猜测项目或搜索磁盘。`);
    const report = { ...parsed, project, harness: bindings.harness, workspaceRoot: bindings.workspaceRoot, cwd, commandId: `report_${randomUUID()}` };
    return contextResponse(`检测到 h:report。使用 $agent-harness-command 在当前任务采集并脱敏相关对话；缺失证据列入 missingEvidence，不得伪造。通过绑定 entrypoint 以 stdin 调用 issue record；只写 controlRoot/issues。不得新建任务、运行 Harness、接受其他输出目录或提交 Git。返回 issue ID、路径和未提交状态。解析结果：${JSON.stringify(report)}`);
  }

  const project = bindings.projects[parsed.projectAlias];
  if (!project) return contextResponse(`Agent Harness 项目别名不存在：${parsed.projectAlias}。可用别名：${Object.keys(bindings.projects).join(', ')}。不得猜测项目、搜索磁盘或启动 Harness。`);
  const intent = { ...parsed, project, harness: bindings.harness, workspaceRoot: bindings.workspaceRoot, cwd };
  return contextResponse(`检测到 Agent Harness 伪命令。把它作为确定性的 Command Intent，而不是自由提示词。使用 $agent-harness-command；只使用已绑定的 entrypoint、dataRoot 和 projectId，验证安装/Registry/Extension 摘要后从该 Extension 的 commandManifest 解析动作和预设。不得根据目标格式猜项目，不得搜索磁盘，不得把参数当作 shell。解析结果：${JSON.stringify(intent)}`);
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
