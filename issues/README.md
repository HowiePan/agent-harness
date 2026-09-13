# Agent Harness 问题登记

本目录保存由 `h:report <project-alias>` 采集并脱敏后的问题记录，属于独立 `agent-harness` 上游仓库的版本化维护制品。

每个问题使用稳定 ID 目录：

```text
issues/
├─ AH-YYYYMMDD-<digest>/
│  ├─ issue.md
│  ├─ intake.json
│  └─ triage.json       # 首次分诊后创建；revisioned
└─ receipts/
   └─ <command-id>.json
```

`intake.json` 保存当前对话中与问题相关的已脱敏摘录、期望、实际结果、复现步骤和缺失证据。它不是 Authority，也不能直接授权修复、Run、Gate、迁移、发布、提交或删除。

同一故障的稳定 `correlation` 会生成 `incidentFingerprint`，用于跨观察时间聚类。Intake 和生成的 `issue.md` 保持不可变；分类、级别、`duplicate-of`、`successor-of`、`fixed-by`、resolution Evidence 与关单状态写入独立 `triage.json`。Triage 更新要求 expected revision、唯一 command ID 和 approved Decision；部署初始化故障可以作为 `deployment-incident` 闭环，不伪造尚不存在的 Descriptor digest 或 Authority revision。

只有字段完整并通过 `defect-bundle.schema.json` 验证后，Issue Intake 才能升级为正式 Defect Bundle。问题记录必须提交并推送到受控远端后，才能保证跨设备留存；Git 操作仍由用户决定。
