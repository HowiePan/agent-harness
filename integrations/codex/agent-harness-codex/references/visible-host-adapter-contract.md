# Codex 可见 Agent 宿主适配器契约

`conversation-visible` 运行必须由当前 Codex 宿主提供完整的可信协调能力。宿主集成使用 `createCodexVisibleHostAdapter({ inspectVisibleAgent, spawnVisibleAgent, waitVisibleAgent, readVisibleResult, sendVisibleAgent?, interruptVisibleAgent? })`，再把返回值作为 `agentAdapter` 传给 `createHarness()`；不得把模型输出、原始 CLI Receipt、文件参数或用户提供的 JSON 当作证明。

`inspectVisibleAgent` 接收 Harness 传入的完整绑定上下文：`agentId`、`dispatchId`、`packetDigest`、`promptDigest`、`surface` 和 `inspectRef`。它必须从宿主原生可见子 Agent 生命周期读取并返回以下字段：

- `verified: true`、`status: queued|running|completed|failed|blocked`；
- 原样绑定的 `agentId`、`dispatchId`、`packetDigest`、`promptDigest`；
- `visibility: { mode: "user-visible", surface, inspectRef }`；
- 宿主生成的非空 `assertionId` 与可解析的 `observedAt`。

`spawnVisibleAgent` 必须接收并原样投递 Harness 编译的 `prompt`，返回宿主 Agent ID、可见 surface、inspect reference 和 spawn Receipt；`waitVisibleAgent` 只读取该 Agent 的原生生命周期；`readVisibleResult` 返回严格符合 visible result schema 的结构化业务结果，并把 focused checks 作为 `runtimeEvidence.verificationReceipts` 保存。适配器在 Lease 绑定和每次 heartbeat 前都会重新观察，并拒绝任意身份、摘要、surface 或 inspect reference 不一致的响应。

`executeVisibleLifecyclePlan()` 是宿主嵌入入口。重启后它从 Authority 查找 active Lease，用持久的 Agent/Dispatch/Packet/Prompt/inspectRef 再次观察，只有 fresh attestation 通过才继续 wait/result；找不到原任务时 preflight 返回 `ACTIVE_LEASE_RESUME_UNAVAILABLE` 或具体宿主观察错误。只有 inspector、spawn、wait、result 四项 capability 全部存在时 `visible-host` 检查才通过。当前 Codex 产品宿主若没有这些原生回调，必须明确保持 unsupported/attention-required，不能回退到 `codex exec`、隐藏进程或独立任务。
