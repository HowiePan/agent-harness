import process from 'node:process';

const actionPattern = /^[a-z][a-z0-9-]{0,31}$/;
const commandPattern = /^h:([^\s]+)(?:\s+(.+))?$/;

export const parsePseudoCommand = prompt => {
  if (typeof prompt !== 'string' || !prompt.startsWith('h:')) return null;
  if (prompt.length > 512 || /[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(prompt)) return { error: '伪命令必须是最长 512 字符的单行文本。' };
  const match = prompt.trim().match(commandPattern);
  if (!match || !actionPattern.test(match[1])) return { error: '语法应为 h:<动作> <目标> [预设]。' };
  const tokens = (match[2] ?? '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 1) return { error: '伪命令缺少目标。语法为 h:<动作> <目标> [预设]。' };
  if (tokens.length > 2) return { error: '伪命令最多接受目标和一个声明式预设；不要在命令后拼接提示词。' };
  return { protocolVersion: '1.0', action: match[1], target: tokens[0], arguments: tokens.slice(1) };
};

export const hookResponse = input => {
  const parsed = parsePseudoCommand(input?.prompt);
  if (!parsed) return null;
  const payload = JSON.stringify({ ...parsed, cwd: input?.cwd ?? null });
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: parsed.error
        ? `Agent Harness 伪命令解析失败：${parsed.error} 不得启动或修改任何 Harness 状态。`
        : `检测到 Agent Harness 伪命令。把它作为确定性的 Command Intent，而不是自由提示词。使用 $agent-harness-command；先按 cwd 从 Project Registry 唯一解析 Project Descriptor，再从其已安装 Extension Pack 读取 commandManifest 并解析动作/预设。不得按项目名称、当前模型或工具猜测语义，不得把参数当作 shell。解析结果：${payload}`,
    },
  };
};

const main = async () => {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const response = hookResponse(JSON.parse(raw));
  if (response) process.stdout.write(JSON.stringify(response));
};

if (process.argv[1] && new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, value => value.slice(1)).replaceAll('/', '\\').toLowerCase() === process.argv[1].replaceAll('/', '\\').toLowerCase()) {
  main().catch(error => {
    process.stderr.write(`Agent Harness pseudo-command hook failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
