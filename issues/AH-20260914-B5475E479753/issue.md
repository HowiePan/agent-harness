# AH-20260914-B5475E479753：V3.8.4 quality Runtime cannot start because Codex CLI rejects sandbox with approve-for-me.

- 状态：Intake / Pending Triage
- 级别：P1
- 观察时间：2026-09-14T10:52:11.934Z
- 项目别名：engine
- Project：cardworld-engine
- Profile：engine-delivery
- Extension：cardworld-engine-profile
- Intake 摘要：b5475e479753fd76998491e6503d7369fb4f81e8a1726eaf71dd2142f13ac761

## 期望

```json
{
  "result": "The bound quality Runtime starts and returns a structured business result for the V3.8.4 quality Feature."
}
```

## 实际

```json
{
  "result": "The Runtime exits before starting the Feature and the Run is marked all-remaining-blocked.",
  "errorCode": "CODEX_CLI_INVALID_FLAG_COMBINATION",
  "stderr": "the argument --sandbox <SANDBOX_MODE> cannot be used with --approve-for-me"
}
```

## 复现

1. Resolve the bound engine project and verify project readiness.
2. Start quality Run v3-8-4-quality-20260914 with the bound codex-cli-runtime.
3. Observe that the Runtime invokes codex exec with --sandbox workspace-write and --approve-for-me.
4. Observe that the Runtime exits before producing result.json; the quality Feature has no changed files and remains blocked.

## 缺失证据

- A corrected Project Runtime configuration or Runtime artifact was not available in this run.
- A successful quality Runtime retry after correcting the flag combination is not available.

## 对话上下文

完整的已脱敏上下文保存在同目录的 `intake.json`；对话只作为问题输入，不是 Harness Authority。共记录 3 条摘录。

## 脱敏

确认：是

移除项：absolute filesystem paths；process identifiers；agent and dispatch UUIDs；content-addressed evidence identifiers
