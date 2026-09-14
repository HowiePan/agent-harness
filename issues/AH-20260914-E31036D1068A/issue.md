# AH-20260914-E31036D1068A：h:engine quality requires repeated user approvals and model-constructed Run configuration, defeating the command automation boundary after Harness artifact updates.

- 状态：Intake / Pending Triage
- 级别：P1
- 观察时间：2026-09-14T12:04:00.000Z
- 项目别名：engine
- Project：cardworld-engine
- Profile：engine-delivery
- Extension：cardworld-engine-profile
- Intake 摘要：e31036d1068a41632e3b65af698a224425afd76ecd7bcdcce6dae017bd24d9e4

## 期望

```json
{
  "behavior": "One explicit h:engine quality V3.8.4 command authorizes all state changes declared by the quality/full manifest scope: deterministic Run construction, scheduling, review-and-repair, and required Gates.",
  "additionalApprovalBoundary": "Request another approval only for actions outside the declared scope or separately protected operations such as publication, commit or push, hard recovery, deletion, or privilege expansion.",
  "artifactUpgradeBehavior": "Approve or trust a verified Harness artifact rotation at install or release time, update bound project identities atomically, and avoid interrupting the next business lifecycle command."
}
```

## 实际

```json
{
  "bootstrap": "A Harness artifact digest rotation made project lifecycle readiness false and interrupted the quality command with PROJECT_HARNESS_IDENTITY_MISMATCH and EXTENSION_ARTIFACT_DIGEST_MISMATCH until a separate bootstrap approval was supplied.",
  "orchestration": "After bootstrap, the assistant had to reconstruct the quality Feature and Run manually because the adapter only parsed intent. The new Run inherited engine-delivery defaults requireCanonicalDecision=true and requireUserCodeReview=true, so scheduling produced no Dispatch.",
  "userExperience": "The user was repeatedly asked to authorize bootstrap, choose a prerequisite strategy, and explicitly approve a canonical decision even though the original command was intended as an automated quality workflow.",
  "residue": "Run v3-8-4-quality-20260914-r2 remains ready with zero Dispatches; business source code and Gates were not changed or executed."
}
```

## 复现

1. Install or publish a new verified Harness artifact whose digest differs from the digest pinned by the cardworld-engine Project Descriptor.
2. From F:\CardWorld, submit h:engine quality V3.8.4.
3. Observe lifecycleReady=false and a required bootstrap plan/apply authorization during the business command.
4. After authorizing bootstrap, construct the quality Run through the current adapter path.
5. Observe that the adapter does not own deterministic action-to-Feature/profile configuration, so the Run uses engine-delivery defaults and schedule returns an empty Dispatch list because canonical-requirement-approved is absent.
6. Observe subsequent conversational requests for prerequisite or safeguard-bypass authorization instead of an automated quality workflow.

## 缺失证据

- No packaged Operator Contract trace was available to show the intended deterministic quality action-to-Run configuration.
- No stable failure code exists for the combined repeated-authorization and command-composition failure; component readiness codes are recorded in actual.bootstrap.
- No successful Dispatch exists for run v3-8-4-quality-20260914-r2 because scheduling returned an empty list.

## 对话上下文

完整的已脱敏上下文保存在同目录的 `intake.json`；对话只作为问题输入，不是 Harness Authority。共记录 6 条摘录。

## 脱敏

确认：是

移除项：Windows account and device identifiers；Unrelated conversation content；Full command outputs and registry payloads；Secrets, credentials, and tokens
