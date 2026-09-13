# AGENTS.md — Agent Harness 独立项目约束

## 当前阶段

- 用户已于 2026-09-12 明确确认现有 Engine Harness 问题已收口。
- 当前版本方案统一为 `V1.0.0`；内部 Wave 不是独立发布版本。
- W0 完成后必须通过 `G0 双轨差异审计 Gate`，未通过不得启动 W1 协议冻结或后续 Kernel/Profile 定型。
- 用户已于 2026-09-12 明确启动 V1.0.0 一次性交付；允许按 W0、G0、W1-W9 连续实现和验证，但中间 Wave 不独立准出。
- V1.0.0 Core、持久 Extension Registry、Standalone Control Root、可安装 Codex 插件、只读 Legacy assessment、Recovery Capsule 与本地打包 Canary 已实现；当前为 Migration Code Ready 候选，独立远端发布、真实 Capsule/cutover 和签名属于迁移执行 Gate。
- 用户已于 2026-09-13 明确：旧 Harness 是否删除以及何时删除只能由用户决定；任何 Gate 通过都不构成删除授权。

## 迁移冻结

- 禁止复制、移动、改写或删除 `tools/agent-harness/**`。
- 禁止复制、移动、改写或删除 `docs/agent-harness/**` 与 `docs/versions/tech/**`。
- 禁止复制、移动、改写或删除 `tabletop-collection` 中的 Harness 代码、文档和运行状态。
- 禁止启动、恢复、迁移或重建 CardWorld、V3.8.4、Collection B1 等真实 Run。
- 禁止因迁移准出、零驻留或 Recovery Capsule 创建而自动删除、移动或归档旧 Harness；必须取得用户对准确目标的单独批准。
- 旧 Harness 只能在用户明确启动 V1.0.0 对应 Wave 后，通过只读 Inventory 和显式迁移流程接入。
- 本轮已获得 V1.0.0 实施授权；G0 只读审计允许执行，真实 Run 恢复、业务仓清理和最终切换仍必须经过对应 Gate。

## 架构边界

- Kernel 不得包含 CardWorld、游戏、批次、Rust、WASM、Codex 或具体模型专名。
- 调度策略、Agent Runtime、Model Router、Tool Broker、Prompt Codec、Gate Executor 和 Storage 通过版本化插件接入。
- 插件只能返回 Intent、Event 或 Receipt，不得直接修改 Kernel Authority。
- 项目差异优先使用声明式 Project Descriptor 和可复用 Profile；项目专用代码是最后手段。
- Engine 与 Collection 都以 Feature 为 Agent 调度单元；Feature 内 Step 默认由同一 Agent 串行完成。
- Collection 的批次 Barrier 只限制跨批次发车；批内仍必须按 Feature 依赖和冲突图决定并行或串行。
- Engine 与 Collection 的正式质量准出都要求当前周期 P0-P3 全部关闭，不允许以 owned debt 延期。
- 业务仓默认零 Harness 驻留：不要求业务仓保存 Harness 代码、Prompt、状态或技术文档。
- Harness Authority、Evidence、Cache 和 Recovery 状态位于业务仓之外。
- 默认 `createHarness()` 只能加载中立 Core、Feature Profile 和参考插件；消费者、供应商 Runtime 与 Legacy Importer 必须通过 Extension Registry 经 Authority 批准安装并绑定完整制品摘要，或由开发态嵌入方显式提供。
- 工具无关 Operator Contract 是协调语义来源；Codex Skill 只是适配器。不得从旧 Skill 补充未契约化行为。

## 可靠性

- Agent 对话、模型输出和插件内部状态都不是权威状态。
- 所有状态写入必须支持 expected revision、幂等 command ID、原子提交和崩溃恢复。
- 所有 Dispatch、Lease、Submission、Gate、Decision 和 Receipt 必须绑定版本、来源与内容摘要。
- ordinary resume 废止旧 Transport；hard recovery 建立新 Epoch，旧状态仅作审计输入。
- 旧结论不得按状态字符串直接升级为新权威结论。

## 开发与 Git

- 正式开发必须在独立仓库或可独立发布的项目边界内进行。
- 不使用正在开发的 Agent Harness 调度自身，直至独立 Canary 和用户批准。
- Git commit、tag、发布和旧文件清理由用户决定。
- 面向用户的规划、迁移和验收报告使用中文。
