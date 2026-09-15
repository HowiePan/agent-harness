# AH-20260915-F9C3FC2090F4：V3.8.4 quality command blocked by invalid Project Descriptor and extension artifact digest mismatch

- 状态：Intake / Pending Triage
- 级别：P1
- 观察时间：2026-09-15T01:16:01.3889729Z
- 项目别名：engine
- Project：cardworld-engine
- Profile：engine-delivery
- Extension：cardworld-engine-profile
- Intake 摘要：f9c3fc2090f4bc6a1f1bfffc90c96d953831b27262f58a67e5b6199a5c88266c

## 期望

```json
"The bound Harness should pass project-scoped readiness and produce a lifecycle quality plan for V3.8.4."
```

## 实际

```json
{
  "readiness": "PROJECT_DESCRIPTOR_RECORD_INVALID",
  "missingPolicyFields": [
    "policy.agentExecutionMode",
    "policy.promptCodecPlugin"
  ],
  "planning": "EXTENSION_ARTIFACT_DIGEST_MISMATCH",
  "expectedDigest": "1321b185d6f7f1cf8a966b10550a36f28c8a789daa62e4de38451ce4e643c6ae",
  "actualDigest": "e730c6d90b7f717bd57194aaad7c05eed8383e1d9a538301864339451ea92ac9",
  "resolvedPath": "F:\\agent-harness\\src\\consumers\\cardworld-engine.mjs",
  "outcome": "No lifecycle plan, Run, or Gate was started."
}
```

## 复现

1. Run the bound Agent Harness doctor command for project engine.
2. Run the bound lifecycle plan for action quality and target V3.8.4.
3. Observe PROJECT_DESCRIPTOR_RECORD_INVALID during readiness and EXTENSION_ARTIFACT_DIGEST_MISMATCH during plan resolution.

## 缺失证据

- No successful lifecycle plan or Run identifier was produced.
- No Gate output was produced because execution did not start.

## 对话上下文

完整的已脱敏上下文保存在同目录的 `intake.json`；对话只作为问题输入，不是 Harness Authority。共记录 3 条摘录。

## 脱敏

确认：是

移除项：Irrelevant conversation context and non-diagnostic metadata omitted.
