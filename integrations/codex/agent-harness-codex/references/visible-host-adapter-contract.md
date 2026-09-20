# Codex 可见 Agent 宿主适配器契约

`conversation-visible` 运行必须由当前 Codex 宿主提供完整的可信协调能力。宿主集成使用 `createCodexVisibleHostAdapter({ inspectVisibleAgent, spawnVisibleAgent, waitVisibleAgent, readVisibleResult, reconcileVisibleHostEffects, confirmVisibleLease, containVisibleAgent, sendVisibleAgent?, interruptVisibleAgent? })`，再通过 `createHarness({ agentAdapters: { 'codex-conversation-runtime': adapter } })` 按 Runtime ID 绑定；不得把模型输出、原始 CLI Receipt、文件参数或用户提供的 JSON 当作证明。通用 `agent-harness-visible-host@1.0.0` 合同位于 `docs/history/legacy-root/host-integration.md`；Codex native contract 仍独立核验。

Codex 插件通过 active Release manifest 中逐文件验证的 `visible-lifecycle-coordinator.mjs` 接入当前任务的 native collaboration tree。宿主前置条件是 Codex Multi-Agent V2，且当前任务必须同时暴露 `collaboration.spawn_agent`、`collaboration.list_agents`、`collaboration.wait_agent` 和 `collaboration.interrupt_agent`；旧 `multi_agent_v1` 没有 Host Effect Journal 所需的列表观察与中断证明语义，禁止兼容性降级。缺少任一工具时必须在启动 Coordinator 前以 `CODEX_MULTI_AGENT_V2_REQUIRED` 失败，提示执行 `codex features enable multi_agent_v2` 后新建任务。Hook 生成最长十分钟、内容摘要绑定的 `codex-visible-lifecycle-intent`；Coordinator 必须在同一长驻进程内重新验证 active Release、生成 Plan、完成 preflight 并执行可见生命周期。Coordinator 使用 `tty:true` 保持 live progress；宿主请求把 `tool` 与 `arguments` 放在 JSON 前部。当前安装的 `PostToolUse` Hook 从原生工具事件的 `tool_input` 与 `tool_response` 直接写入 Control Root 中与当前 Codex session、请求摘要和工具调用 ID 绑定的响应；控制器只原样调用工具，不向 stdin 手写 Host 帧。Host 请求和响应以单请求串行协议传输，每个响应必须逐字段匹配 session、request、request digest、operation 和 tool，且只能封装刚刚返回的原生 collaboration tool result；跨请求重放、额外字段、缺字段、任务 ID 漂移均拒绝。Native Contract `codex-collaboration-native@1.3.0` 要求 `spawn_agent` 精确返回 `{ task_name }`，该值必须与请求任务名一致并由 `list_agents` 的 `{ agents: [{ agent_name, agent_status }] }` 唯一复核为 canonical `agent_name`；请求任务 identity、返回任务 identity 与可见任务 identity 不得混用。`wait_agent` 精确返回 `{ message, timed_out }`。`agent_status` 的当前宿主终态包括 `{ completed: string }`、`{ failed: string }`、`completed`、`failed`、`blocked`、`idle` 和 `interrupted`；`interrupted` 必须被视为已收容终态。`spawn_agent` 固定 `fork_turns=none`，禁止从父对话隐式继承提示上下文。

`inspectVisibleAgent` 接收 Harness 传入的完整绑定上下文：`agentId`、`dispatchId`、`packetDigest`、`promptDigest`、`surface` 和 `inspectRef`。它必须从宿主原生可见子 Agent 生命周期读取并返回以下字段：

- `verified: true`、`status: queued|running|completed|failed|blocked`；
- 原样绑定的 `agentId`、`dispatchId`、`packetDigest`、`promptDigest`；
- `visibility: { mode: "user-visible", surface, inspectRef }`；
- 宿主生成的非空 `assertionId` 与可解析的 `observedAt`。

`spawnVisibleAgent` 必须接收并原样投递 Harness 编译的 `prompt`，返回 collaboration tree 的规范任务名、可见 surface、inspect reference 和绑定 session/request/Dispatch/packet/prompt 的 spawn Receipt；`waitVisibleAgent` 只等待并重新读取该 Agent 的原生生命周期；`readVisibleResult` 对 native `{ completed: string }` 只解析其中的单一严格 JSON 对象，对 failed、blocked、idle、interrupted 或缺少结构化输出的 completed 终态生成固定、可校验的宿主失败结果，使 Authority 能提交失败并关闭 Lease，而不是把失败 Agent 永久重附着。所有终态结果都把 checkpoints 与结果摘要绑定后作为 `runtimeEvidence.verificationReceipts` 保存。适配器在 Lease 绑定和每次 heartbeat 前都会重新观察，并拒绝任意身份、摘要、surface、inspect reference 或 spawn Receipt 不一致的响应。

每次 native spawn 之前，Coordinator 必须在 Control Root 数据区原子提交 `Host Effect Journal`。状态机为 `spawn-requested -> spawn-responded -> agent-observed -> lease-bound -> settled`，失败分支只能进入 `contained`。Journal 写入支持 expected revision、幂等 command ID、原子替换和崩溃恢复。preflight 先调用 `reconcileVisibleHostEffects`：Authority 中仍有 active Lease 的 Effect 保留并重附着；其他未完成 Effect 必须调用 `interrupt_agent`，再用 `list_agents` 证明目标已消失、idle 或 terminal。无法证明收容时 `visible-host-contract` 失败，禁止创建 Run 或开启下一 Agent。spawn 已成功但 attestation/Lease 绑定失败时同样先收容；Authority Lease 已经提交但确认回执中断时不得误杀 Agent，而应保留 Lease 等待重附着。

`executeVisibleLifecyclePlan()` 是宿主嵌入入口。重启后它从 Authority 查找 active Lease，用持久的 Agent/Dispatch/Packet/Prompt/inspectRef 再次观察，只有 fresh attestation 通过才继续 wait/result；找不到原任务时 preflight 返回 `ACTIVE_LEASE_RESUME_UNAVAILABLE` 或具体宿主观察错误。只有 inspect、spawn、wait、result、reconcile、confirm、contain 七项 capability 全部存在，并且 native contract reconciliation 通过时，`visible-host` 与 `visible-host-contract` 检查才通过。该规则位于共享 lifecycle executor，因此 Engine 与 Collection 的全部 `conversation-visible` state-changing action 使用同一条约束，不允许 action-specific 绕过。当前 Codex 产品宿主若没有这些原生回调，必须明确保持 unsupported/attention-required，不能回退到 `codex exec`、隐藏进程或独立任务。

## Dispatch 结果契约

新 Dispatch 的 Prompt Contract 为 `1.2`，携带 `agent-harness-dispatch-result@1.1` 的摘要。Prompt 明确给出可见结果 JSON 形状、当前 Feature 的端口 Schema ID 与值 Schema。旧 `1.0` Dispatch 重附着时仍使用原 Prompt。可见 Host Adapter 接受 `visible-agent-result.schema.json`，其中成功结果可携带 `outputs`；不再把仅供 CLI provider 使用的 `codex-runtime-result.schema.json` 套到原生可见结果上。Harness 随后按绑定的端口名、Schema ID、值 Schema 和业务 Profile 复验，不能凭 Host 传输通过就提交完成。

原生 Agent 已经完成，但最后的文本不是单一 JSON 对象或不符合可见传输 Schema 时，适配器保存原始文本摘要、原生观察请求摘要、字段错误和拒绝摘要，以 `runtime-contract` 失败结果收束已终态 Lease。它不会补造成功端口，也不会将原始文本提升为业务完成结论。失败或阻断终态不要求成功端口。仍无法确认 Agent 终态时保留 Lease，等待重新观察和收容。

Preflight 逐 Feature 编译结果契约；缺少端口值 Schema 时报告 `RESULT_OUTPUT_VALUE_SCHEMA_REQUIRED`。固定结果 Schema 的 CLI Runtime 无法承载类型化端口时，在 spawn 前报告 `RUNTIME_TYPED_OUTPUT_CONTRACT_UNSUPPORTED`。过期 Readiness 会对同一 Plan 重新预检，任何新的 Source、Release、Lineage 或 Host blocker 仍阻止发车。
