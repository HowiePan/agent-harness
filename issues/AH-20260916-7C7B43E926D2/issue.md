# AH-20260916-7C7B43E926D2：Agent Harness resolved a review-and-repair quality command into a read-only Feature, so the required repair phase was not started.

- 状态：Intake / Pending Triage
- 级别：P1
- 观察时间：2026-09-16T13:44:39.159Z
- 项目别名：engine
- Project：cardworld-engine
- Profile：engine-delivery
- Extension：cardworld-engine-profile
- Intake 摘要：7c7b43e926d2255f5e51c5d67046824748093e140d384d3ba29deb818f813f40

## 期望

```json
{
  "policy": "review-and-repair",
  "lifecycle": "The quality lifecycle should review findings, execute or schedule the declared repair work, rerun validation, and close only after the repair-aware stop condition is satisfied."
}
```

## 实际

```json
{
  "plan": "The generated Feature had allowedPaths=[] and explicitly prohibited workspace writes.",
  "consequence": "Only the review stage ran; no repair stage was started.",
  "inconsistency": "The plan metadata declared sourcePolicy review-and-repair while its Feature contract was read-only."
}
```

## 复现

1. Run h:engine quality V3.8.4 in the bound engine workspace.
2. Inspect the generated lifecycle plan and Feature acceptance data.
3. Observe sourcePolicy review-and-repair together with allowedPaths=[] and a no-workspace-writes requirement.
4. Observe that the lifecycle reports review findings without entering a repair phase.

## 缺失证据

- The authoritative manifest/descriptor diff explaining why review-and-repair resolved to a read-only Feature was not available in the conversation.
- A formal lifecycle completion event confirming repair-phase execution was not observed.

## 对话上下文

完整的已脱敏上下文保存在同目录的 `intake.json`；对话只作为问题输入，不是 Harness Authority。共记录 4 条摘录。

## 脱敏

确认：是

移除项：machine-specific absolute paths；control-root paths；run and dispatch identifiers；prompt and artifact digests；workspace-specific temporary paths
