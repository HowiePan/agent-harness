# Agent Harness

Agent Harness 是运行在业务仓库之外的 Agent 流程控制面。它把需求输入、工作拆分、Agent 执行、确定性检查、人工决定、证据和恢复组织为可持久化的 Run。一个工作区可以包含多个项目、多个源码或文档来源，并选择已经安装的流程。工具、模型和业务项目通过版本化扩展接入。

它适合需要跨会话继续、同时管理多个功能或项目、追溯答案和交付依据的工作。Agent Runtime 可以按 Flow 实现业务代码，但 Harness 本身不替业务方决定需求是否正确，也不把模型对话当作权威状态。业务仓保存项目自有的声明式 `harness.json`，默认不存 Harness 实现、Prompt、Authority、Evidence 或缓存。

## 能做什么与不能做什么

Harness 能把项目配置编译成固定身份的 Descriptor，把 Flow 编译成可审计 Feature DAG，驱动可信宿主 Agent，执行确定性 Gate，保存 Evidence/Finding/Decision/Receipt，并在崩溃或跨会话后按 Authority 恢复。它支持多项目 Source/Resource 隔离、类型化分支、有界循环、质量修复复审和直接链接源码的本地调试。

Harness 不能自行批准受保护动作、猜测未绑定的项目或 Workflow、把自由文本升级为 Gate/Decision、绕过宿主能力启动隐藏 Agent、在活动 Run 中热替换源码、自动提交或发布、因迁移通过而删除旧 Harness，也不能保证真实业务质量而无需现场验收。

## 已实现能力

- **工作区**：稳定 ID、别名、成员项目、执行目标、来源、流程和资源绑定。修改产生新修订；旧 Run 保留原快照，撤权会阻止后续访问。
- **流程与实例**：版本化节点图可选择不同动作；单实例运行或并行启动多个实例。Feature 根据依赖和冲突调度，同一 Feature 内步骤顺序执行。
- **执行与治理**：Runtime、Scheduler、Model Router、Tool Broker、Codec、Gate 和 Storage 通过插件接入。Dispatch 固定输入与制品身份，提交须符合结果合同；P0–P3 问题在正式质量准出前全部关闭。
- **持久状态**：每次状态修改用预期修订和幂等命令 ID 原子提交。Evidence 与 Receipt 留下可核查的来源和结论。恢复区分普通继续与建立新 Epoch 的硬恢复。
- **知识与来源**：来源在 Plan 中固定，读取受项目、流程和 Runtime 权限约束。记忆可按工作区通用、项目、流程、来源和会话分隔；来源变化使受影响结论要求复核。
- **宿主接入**：CLI/API、Codex 命令适配器及可安装 Extension Pack。默认 Core 不隐式加载业务流程或供应商 Runtime。

## 已实现的四条流程

| 流程 | Workflow ID | 典型输入与主要阶段 | 输出及当前绑定 |
| --- | --- | --- | --- |
| 版本交付 | `delivery-lifecycle` | 版本目标；需求收集、规范化、计划、实现、范围、文档、质量、评审、交付 | 中立交付回执；`engine-delivery` 由 CardWorld Legacy shim 保留 |
| 批次生产 | `batch-production` | 批次与 item；规则、生产、质量、评审、验收、关闭 | 中立批次及逐项验收；`collection-batch-production` 由 Collection Legacy shim 保留 |
| 需求与设计整理 | `requirements-design` | 多份需求文档和多个代码仓；采集、合并、检索、影响映射、两份文档、复核 | 完整需求与功能细节文档、设计文档及知识候选 |
| 知识问答 | `knowledge-qa` | 问题、会话与可访问知识/代码来源；解析、记忆查询、必要时检索、回答或澄清 | 有证据的回答或明确的澄清问题；反馈可驱动后续记忆处理 |

前两条中立流程使用新的中立 Workflow/Profile/Extension 身份；CardWorld 与 Collection 的旧身份、命令、字段和领域规则仅存在于 `integrations/legacy-consumers/` 的显式兼容 shim。依赖方向只能从 shim 指向中立 Flow，不能反向导入。后两条流程以 Workspace 的来源和资源权限工作。四条流程都可通过命令选择；实例数量由启动方式决定，不是另一条流程。

## 一次运行怎样完成

```text
命令/调用 → 工作区与流程精确解析 → 确定性 Plan → 预检 → Run
                                                       ↓
关闭回执 ← Gate / Decision ← 提交与证据 ← Dispatch / Agent
```

例如，工作区 `alpha` 包含前端、后端两个项目，共享需求文档来源，并分别绑定代码来源。命令 `h:alpha flow requirements-design analyze audit-trail` 选择工作区和流程；Plan 固定来源清单、输出路径、流程版本和工作区修订。节点采集需求、检索两个仓、生成需求与设计文档，经复核通过后 Run 才能关闭。另一个命令 `h:alpha flow knowledge-qa ask audit-trail --project alpha-front` 可只在前端项目范围内问答；相同业务概念的工作区通用记忆可复用，后端专有记忆不会越权进入前端结果。

业务方接入时，在项目仓创建 `harness.json`，用统一 InitPlan/InitReceipt 注册精确 Extension 和 Project；多项目场景再注册 Workspace，声明成员项目、来源、执行目标和资源权限。启动命令生成 Plan，预检确认执行权限，再运行到关闭。工作区新增仓库或变更知识权限时提交新修订；旧 Run 不会被静默改写。打包环境可用包内 `docs`、`config schema/validate` 和中立示例完成接入，不依赖源码。

## 当前验证范围

本地合成 Canary 已通过命令解析、Workspace 绑定、Plan、预检、Dispatch、Submission、Gate/Decision 和关闭路径运行四条流程，并验证两个工作区、同一工作区多项目、来源及记忆隔离、增仓、撤权和回滚。它证明 Harness 协议和参考执行路径可闭环。真实 Codex 宿主在真实业务仓的执行质量、旧 Run 切换、远端发布和签名仍分别需要现场 Gate 与所有者决定。当前版本是 `1.0.0` 的 Migration Code Ready 候选。
