# AH-20260915-43658BE83791：Interactive quality command selected a headless CLI Agent instead of a visible child Agent

- 状态：Intake / Pending Triage
- 级别：P1
- 观察时间：2026-09-15T11:32:07.7225983Z
- 项目别名：engine
- Project：cardworld-engine
- Profile：engine-delivery
- Extension：cardworld-engine-profile
- Intake 摘要：43658be83791b0553b4cadd026295ab8f015053e5b3996a70d1c856b70ea4949

## 期望

```json
{
  "executionMode": "conversation-visible",
  "behavior": "Use the host lifecycle Coordinator to create and observe a visible child Agent for an interactive command."
}
```

## 实际

```json
{
  "executionMode": "headless",
  "runtime": "codex-cli-runtime",
  "userVisible": false,
  "behavior": "The quality Run launched a process-backed CLI Agent."
}
```

## 复现

1. Run h:engine quality V3.8.4 in an interactive Codex task.
2. Inspect the resolved lifecycle plan and Run runtime policy.
3. Observe that the Run uses headless mode and codex-cli-runtime rather than a visible child Agent.

## 缺失证据

- The original host command-scoped grant payload was not available in this thread.
- No host-level visible-agent adapter trace was available.

## 对话上下文

完整的已脱敏上下文保存在同目录的 `intake.json`；对话只作为问题输入，不是 Harness Authority。共记录 2 条摘录。

## 脱敏

确认：是

移除项：Absolute control-root and runtime filesystem paths；Process IDs, agent IDs, lease IDs, packet digests, and unrelated Authority records；Personal account or host-identifying details
