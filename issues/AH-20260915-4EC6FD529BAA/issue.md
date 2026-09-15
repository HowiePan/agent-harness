# AH-20260915-4EC6FD529BAA：conversation-visible 生命周期无法完成可信 Agent Lease 绑定，阻塞 Harness 正式收口

- 状态：Intake / Pending Triage
- 级别：P1
- 观察时间：2026-09-15T02:25:01.4731569Z
- 项目别名：engine
- Project：cardworld-engine
- Profile：engine-delivery
- Extension：cardworld-engine-profile
- Intake 摘要：4ec6fd529baa3d9f8d906c4bd8a0ecc8cdff7f629ec6121ada775676f5a274ce

## 期望

```json
"宿主创建可见子 Agent 后，应提供绑定 Agent、Dispatch、Packet、Prompt 摘要及可检查任务引用的 Runtime Receipt，并由可信适配器完成 Lease 证明。"
```

## 实际

```json
"质量子 Agent 已完成审查，但当前宿主仅提供 Agent 标识与结果，未提供 Harness 可验证的可信宿主 attestation；绑定阶段按策略停止。"
```

## 复现

1. 在 engine 项目上执行 quality V3.8.4。
2. Harness 以 conversation-visible 模式启动 Run、创建 Dispatch，并生成确定性子 Agent 指令。
3. 宿主创建可见子 Agent 后尝试绑定 Lease。
4. 绑定因缺少可信宿主证明适配器而返回 attention-required，未能继续 heartbeat、提交结果和正式收口。

## 缺失证据

- Codex 宿主侧 verifyVisibleLease 实现或等价可信适配器接口
- 绑定 Agent、Dispatch、Packet 摘要和 Prompt 摘要的 Runtime Receipt
- 可检查的宿主任务引用及其观察状态
- Lease 绑定后的新鲜 heartbeat 回执

## 对话上下文

完整的已脱敏上下文保存在同目录的 `intake.json`；对话只作为问题输入，不是 Harness Authority。共记录 3 条摘录。

## 脱敏

确认：是

移除项：绝对文件路径；Run/Dispatch/Agent 标识；摘要值；可能的宿主内部标识
