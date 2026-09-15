# AH-20260915-5323CEA6386F：conversation-visible 生命周期在首次 Dispatch 启动时因宿主协作工具返回契约不兼容而失败。

- 状态：Intake / Pending Triage
- 级别：P1
- 观察时间：2026-09-15T14:10:20.5380660Z
- 项目别名：engine
- Project：cardworld-engine
- Profile：engine-delivery
- Extension：cardworld-engine-profile
- Intake 摘要：5323cea6386f37a2a9714dbf48091f4d75fd0821bf99e9186eb125bc0a597a1d

## 期望

```json
{
  "spawnResult": {
    "requiredKeys": [
      "task_name"
    ],
    "canonicalIdentity": "Harness-generated ah_* task name"
  },
  "visibleHost": "collaboration.spawn_agent/list_agents/wait_agent adapter contract"
}
```

## 实际

```json
{
  "failureCode": "CODEX_COLLABORATION_SPAWN_RESULT_INVALID",
  "observed": "Coordinator rejected the native spawn result envelope before Lease binding.",
  "exposedSpawnShape": {
    "keys": [
      "agent_id",
      "nickname"
    ]
  }
}
```

## 复现

1. 运行 h:engine quality V3.8.4。
2. Coordinator 完成 executionReady=true 的 preflight 并发出 conversation-visible spawn 请求。
3. 通过当前宿主暴露的通用子智能体工具执行 spawn_agent，并将其结果原样回传。
4. Coordinator 报告 CODEX_COLLABORATION_SPAWN_RESULT_INVALID，生命周期在首次 Dispatch 处停止。

## 缺失证据

- 宿主未提供与 Harness visible-host adapter 对应的 collaboration 工具 manifest/version。
- 未取得能够证明 spawn/list/wait/result 四项回调实际契约一致的 preflight handshake 证据。

## 对话上下文

完整的已脱敏上下文保存在同目录的 `intake.json`；对话只作为问题输入，不是 Harness Authority。共记录 3 条摘录。

## 脱敏

确认：是

移除项：未写入具体 agent UUID、session/request ID、dispatch digest 或完整本地运行路径。
