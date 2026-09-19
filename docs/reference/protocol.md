# 协议与不变量

Kernel 是唯一改变 Run Authority 的组件。每个写命令具有预期修订、幂等命令 ID、规范化 payload；同 ID 不同 payload 拒绝，修订冲突要求重新读取。状态提交原子化并可崩溃恢复。Agent、模型、插件与宿主只提交经校验的 Intent、Result、Event 或 Receipt。

Run 固定 Workspace 修订、项目范围、Workflow ID/版本/制品摘要、来源清单、Epoch 与 Generation。Feature 是最小 Agent 调度单元，内部 Step 串行；Feature 之间按依赖和冲突图调度。Dispatch、Lease、Submission、Gate、Decision、Evidence 和关闭 Receipt 都绑定版本、来源和摘要。关闭之前必须满足图完成、质量、Gate 与人工 Decision 条件。

普通继续保留原 Epoch 和预算但废止 Transport；硬恢复需要验证 Capsule 和 Resolution Receipt，建立新 Epoch，旧结论只作审计输入。Workspace 或 Extension 更新不会更改已固定 Run 的身份；撤权在下一次 Dispatch/来源或资源读取生效。各对象的严格字段由 `schemas/` 中版本化 JSON Schema 和当前源码合同定义。
