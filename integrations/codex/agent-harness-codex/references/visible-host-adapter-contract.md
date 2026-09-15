# Codex 可见 Agent 宿主适配器契约

`conversation-visible` 运行必须由当前 Codex 宿主提供可信观察能力。宿主集成在创建 Harness 时使用 `createCodexVisibleHostAdapter({ inspectVisibleAgent })`，再把返回值作为 `agentAdapter` 传给 `createHarness()`；不得把模型输出、原始 CLI Receipt 或用户提供的 JSON 当作证明。

`inspectVisibleAgent` 接收 Harness 传入的完整绑定上下文：`agentId`、`dispatchId`、`packetDigest`、`promptDigest`、`surface` 和 `inspectRef`。它必须从宿主原生可见子 Agent 生命周期读取并返回以下字段：

- `verified: true`、`status: queued|running|completed`；
- 原样绑定的 `agentId`、`dispatchId`、`packetDigest`、`promptDigest`；
- `visibility: { mode: "user-visible", surface, inspectRef }`；
- 宿主生成的非空 `assertionId` 与可解析的 `observedAt`。

适配器在 Lease 绑定和每次 heartbeat 前都会重新观察，并拒绝任意身份、摘要、surface 或 inspect reference 不一致的响应。没有观察能力时必须返回 `attention-required`，不能回退到 `codex exec`、隐藏进程或独立任务。
