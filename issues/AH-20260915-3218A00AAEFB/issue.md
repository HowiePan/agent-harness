# AH-20260915-3218A00AAEFB：Quality command required an extra headless authorization and then launched a backend CLI runtime despite the interactive task context and the user prohibition against backend CLI execution.

- 状态：Intake / Pending Triage
- 级别：P1
- 观察时间：2026-09-15T07:41:35.0123698Z
- 项目别名：engine
- Project：cardworld-engine
- Profile：engine-delivery
- Extension：cardworld-engine-profile
- Intake 摘要：3218a00aaefb196b1c54242e18cf37f9750099726ab5a83533b75efa6c3d462a

## 期望

```json
"The command should either use an inspectable conversation-visible execution path or fail closed before starting any backend CLI when that execution mode is not explicitly acceptable; authorization should not be broadened from quality execution to backend CLI launch."
```

## 实际

```json
"The resolved quality plan selected codex-cli-runtime with headless execution. After the user replied with a general authorization, lifecycle execute started a managed backend CLI process. The process was later stopped by user request and its Lease was superseded through ordinary recovery."
```

## 复现

1. Submit h:engine quality V3.8.4 in the bound CardWorld workspace.
2. Observe that the resolved plan selects headless execution with codex-cli-runtime and that an additional authorization prompt is issued.
3. Reply with authorization without separately authorizing a backend CLI process.
4. Observe lifecycle execution start a managed backend CLI process for the quality Run.
5. Request stop and observe the process stop while the Harness Run requires recovery to supersede the active Lease.

## 缺失证据

- No structured runtime error code was emitted for the policy mismatch.
- No independent persisted user-preference artifact was available to establish the backend-CLI prohibition before the launch.

## 对话上下文

完整的已脱敏上下文保存在同目录的 `intake.json`；对话只作为问题输入，不是 Harness Authority。共记录 4 条摘录。

## 脱敏

确认：是

移除项：Absolute filesystem paths；Full UUIDs and run identifiers；Process IDs；Full artifact and source digests；Account or host-specific identifiers
