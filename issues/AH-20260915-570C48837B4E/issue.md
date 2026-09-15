# AH-20260915-570C48837B4E：conversation-visible 宿主桥接失败后未等待或收容已创建的子智能体，并继续启动后续 Dispatch；共享桥接契约可能影响所有 conversation-visible 流程。

- 状态：Intake / Pending Triage
- 级别：P1
- 观察时间：2026-09-15T14:24:58.9924421Z
- 项目别名：engine
- Project：cardworld-engine
- Profile：engine-delivery
- Extension：cardworld-engine-profile
- Intake 摘要：570c48837b4edbf14b047c2c64d5c6b7e34cca43c4d6f2b3a3b710a776733759

## 期望

```json
{
  "dispatchLifecycle": [
    "一个已创建的子智能体必须先被唯一观察并绑定 Lease，随后等待并消费其终态结果，才能推进同一串行 Feature。",
    "若 Spawn 后的宿主契约校验失败，必须先中断或以可验证方式收容已创建的子智能体，再允许恢复或创建后续 Transport。"
  ],
  "sharedHostContract": "对 spawn、inspect、wait、interrupt 和 result 的真实宿主契约进行版本化验证，并覆盖所有选择 conversation-visible Runtime 的生命周期动作。"
}
```

## 实际

```json
{
  "unawaitedAgent": "原生 spawn_agent 已返回成功结果，但适配器在 Lease 绑定前拒绝返回 envelope；失败路径未等待该子智能体的终态。",
  "uncontainedAgent": "失败路径没有保存可用于观察或中断的原生 Agent 身份，也没有调用 interrupt_agent；后续 ordinary resume 继续调度了新 Dispatch。",
  "authorityObservation": "同一 active Run 已推进到 generation 4，存在四个 requested/superseded Dispatch 且没有 Lease，因此 Authority 无法证明先前原生子智能体已经终止。",
  "commonImpact": "Codex visible lifecycle Coordinator 对所有 conversation-visible 动作复用同一 Host Adapter；现有测试只模拟了非真实的 task_name 返回，因此单点修补不足以证明其它流程可用。"
}
```

## 复现

1. 运行 h:engine quality V3.8.4，使 Coordinator 创建首个原生子智能体。
2. 将当前宿主的 spawn_agent 原生返回原样交给 Coordinator；适配器以 CODEX_COLLABORATION_SPAWN_RESULT_INVALID 失败。
3. 观察失败路径未等待或中断已创建的子智能体，并且 Authority 中未产生 Lease。
4. 再次运行同一生命周期命令；ordinary resume 使 generation 增加并请求新的 Dispatch，而上一原生子智能体没有可验证的终止或收容 Receipt。
5. 检查其它 conversation-visible 动作，确认它们共享同一 Codex collaboration Host Adapter 和相同的未验证边界。

## 缺失证据

- 先前已创建原生子智能体的当前状态和最终输出不可用，因为失败路径未持久化可观察身份或 Lease。
- 宿主未提供可绑定的 collaboration 工具 manifest、协议版本或契约摘要。
- 尚无覆盖所有 conversation-visible 动作及 spawn/list/wait/interrupt/result 的真实产品宿主 Canary。

## 对话上下文

完整的已脱敏上下文保存在同目录的 `intake.json`；对话只作为问题输入，不是 Harness Authority。共记录 2 条摘录。

## 脱敏

确认：是

移除项：未记录原生 agent_id、nickname、session/request ID、Dispatch UUID、Prompt 内容或完整业务仓路径。
