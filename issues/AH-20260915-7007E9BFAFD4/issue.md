# AH-20260915-7007E9BFAFD4：Quality lifecycle exposes resumable Run lineage choice to the user instead of resolving it internally.

- 状态：Intake / Pending Triage
- 级别：P2
- 观察时间：2026-09-15T10:04:24.0299783Z
- 项目别名：engine
- Project：cardworld-engine
- Profile：engine-delivery
- Extension：cardworld-engine-profile
- Intake 摘要：7007e9bfafd446ffe882b9cae9b8ec014b4a5aa163c483301686b5ad30535f57

## 期望

```json
"The Harness should internally reuse a safe resumable Run when the target, source snapshot, and lifecycle intent match; user intervention should be reserved for genuinely protected or ambiguous operations."
```

## 实际

```json
"The quality command stopped at preflight with ACTIVE_LOGICAL_RUN_CONFLICT and required the user to choose between resuming the existing Run and creating a replacement Run, even though the existing Run was ready, had no submissions or findings, and had no active lease."
```

## 复现

1. Submit the bound command h:engine quality V3.8.4.
2. Allow the Harness to resolve the quality/full intent and run action-scoped preflight.
3. Observe that a ready Run with the same target and source snapshot is reported as a conflict.
4. Observe that the adapter asks the user to authorize resume versus replacement instead of applying an internal lineage policy.

## 缺失证据

- No upstream Harness issue tracker reference was provided.
- No implementation patch or maintainer decision about resumable lineage policy is attached.

## 对话上下文

完整的已脱敏上下文保存在同目录的 `intake.json`；对话只作为问题输入，不是 Harness Authority。共记录 2 条摘录。

## 脱敏

确认：是

移除项：Local filesystem paths and control/data root locations；Run, lease, process, command, artifact, authority, and snapshot identifiers；Host-specific metadata and unneeded raw tool output
