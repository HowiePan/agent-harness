# AH-20260913-DA8CA73021DB：Bound Agent Harness cannot execute the engine quality command because its active data root is uninitialized, the extension registry is empty, and project registry access hits EPERM.

- 状态：Intake / Pending Triage
- 级别：P2
- 观察时间：2026-09-13T13:06:44.4627696Z
- 项目别名：engine
- Project：cardworld-engine
- Profile：engine-delivery
- Extension：cardworld-engine-profile
- Intake 摘要：da8ca73021dbd2d0bda2e4f65c04e63bf53f9a15fbea44933b55fd7090b70ddd

## 期望

```json
"The bound Harness installation should expose a writable initialized data root, the registered engine extension and project descriptor, and permit the quality workflow to resolve and start."
```

## 实际

```json
{
  "doctor": "releaseVerified=true; initialized=false",
  "extensions": "registeredExtensions=[]",
  "projectList": "EPERM while creating F:\\agent-harness\\.agent-harness-data\\authority",
  "lifecycle": "quality command stopped at attention-required before Run creation"
}
```

## 复现

1. Resolve the engine binding from the installed plugin binding file.
2. Run the bound Harness doctor against F:\agent-harness and F:\agent-harness\.agent-harness-data.
3. Observe releaseVerified=true but initialized=false.
4. Run extension list and observe an empty extension registry.
5. Run project list and observe EPERM while creating the authority directory.
6. Resolve h:engine quality V3.8.4 and observe that the lifecycle preflight cannot proceed.

## 缺失证据

- No Hook-provided command ID was exposed in the conversation context; this report uses a fresh recorder command ID.
- No active Project Descriptor or Extension artifact identity was available from the bound registry.
- No Authority revision or Run ID was available because the active data root is uninitialized.

## 对话上下文

完整的已脱敏上下文保存在同目录的 `intake.json`；对话只作为问题输入，不是 Harness Authority。共记录 5 条摘录。

## 脱敏

确认：是

移除项：Credentials, tokens, and unrelated conversation content.
