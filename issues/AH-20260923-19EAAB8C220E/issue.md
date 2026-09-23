# AH-20260923-19EAAB8C220E：已安装并信任的 Codex 插件未收到 list_agents 的 PostToolUse，真实宿主交换超时

- 状态：Intake / Pending Triage
- 级别：P1
- 观察时间：2026-09-23T14:36:27.617Z
- 项目别名：harness
- Project：agent-harness
- Profile：codex-channel
- Extension：agent-harness-codex
- Intake 摘要：19eaab8c220e896a0fa129d217c8f2c6ee09087a48028b8b32319be7ba6f9a4c

## 期望

```json
{
  "outcome": "真实 Codex list_agents 调用完成后，已信任的 PostToolUse Hook 自动提交与当前待处理请求绑定的 Host 响应。"
}
```

## 实际

```json
{
  "nativeToolResult": "list_agents 正常返回当前 Agent 状态",
  "hostExchangeCode": "CODEX_HOST_HOOK_RESPONSE_TIMEOUT",
  "hostResponseCreated": false,
  "newHookStageObserved": false,
  "scope": "G2 真实宿主短探针；尚未创建合成质量 Run"
}
```

## 复现

1. 从已验证的不可变 Core/Codex 组合完成同版本插件 remove/add 并检查安装缓存。
2. 在 CLI /hooks 审核并信任当前插件 PostToolUse 与 UserPromptSubmit，确认 Active 1、Review 0。
3. 新建 Codex Desktop 任务，以真实会话 ID 创建一条限时 Host 请求，然后调用一次 collaboration.list_agents({})。
4. 检查原生结果、对应 response.json、Hook 阶段目录与超时拒绝回执。

## 缺失证据

- Desktop 当前构建对 list_agents 的 Hook 启动、匹配及完成事件。
- 同一安装制品在独立合成项目中的真实 Host 请求/响应和质量闭环回执。

## 对话上下文

完整的已脱敏上下文保存在同目录的 `intake.json`；对话只作为问题输入，不是 Harness Authority。共记录 2 条摘录。

## 脱敏

确认：是

移除项：用户账户路径；原始日志中的非必要会话内容
