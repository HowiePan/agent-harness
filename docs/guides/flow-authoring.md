# 编写可独立发布的 Flow

Flow 是 Extension Pack 中的版本化 Workflow、Planner、节点模板、结果合同和关闭策略。它不能直接写 Authority，也不能要求消费者阅读其源码才能配置。

## 标准内容

一个 Flow 包应提供公开入口、Extension、纯 Planner、Workflow Definition、按阶段组织的节点、类型化合同、Profile/Policy、命令清单和设计文档。Extension manifest 固定 ID、版本、Workflow 摘要、Profile、操作执行类别和权限；每个 operation 都必须是 `pure-planner`。Agent 工作使用 `agent-reasoning` Feature，确定性进程检查使用 Project Gate Recipe。

## 输入和计划

Planner 只把已批准的 Descriptor、Command Intent、Source Manifest、Target snapshot 和 Flow 参数编译成确定性 Plan，不启动进程、不写状态。计划必须固定 Workflow ID/版本/摘要、Extension、Profile、Runtime、项目范围、Source digest、Feature DAG、结果合同、Gate/Decision 和停止条件。相同输入必须产生相同摘要。

## 节点与结果

每个节点声明稳定 ID、模板、依赖、可选扇出、来源权限、允许/禁止路径、冲突键、Node Task Contract 和 `outputPorts`。Task Contract 必须完整声明 `role`、`objective`、`instructions`、`inputs`、`steps`、`constraints`、`acceptance` 与 `evidenceRequirements`；禁止用泛化默认 Prompt 代替节点语义。每个端口固定 Schema ID和值 Schema；输出值和 Evidence 引用由结果合同校验。读写边界必须从 Feature 产生，不能靠 Prompt 约定。

直接依赖节点的全部 typed outputs 会由 Workflow 编译器自动生成 `upstream` Task 输入；分支与 repeat 会把触发端口绑定到追加 Feature。非上游输入必须明确绑定 `intent`、`feature`、`workspace`、`source-manifest`、`memory` 或 `quality-target` 的字段路径。必填输入在 Dispatch 时解析失败会阻止执行。项目配置不能提供自由文本 Prompt；需要新语义时应发布新的 Task Contract/Flow 制品。

路线、扇出、分支和有界循环的完整规则见 `agent-harness docs show control`。特别注意：静态图只能向前依赖；循环通过带 `maxIterations` 的 repeat continuation 展开为新 Feature，不能建立环形 DAG。

## Gate、Decision 与关闭

Flow Policy 声明必需的 fresh final Gates、人工 Decisions、Finding 策略和关闭条件。业务语言、构建系统或项目专用 Gate 应放在项目 Descriptor 或显式集成变体，不进入 Kernel 和中立 Flow。质量检查只读；修复是单独的路径受限 Feature；修复后必须在新 Source digest 上全量复审。

## 文档合同

每条 Flow 的发布文档必须独立说明：用途与非用途、动作和预设、全部输入、节点图、分支/repeat、端口 Schema、Evidence、路径和来源权限、Gate/Decision、预算、失败恢复、Workspace 参数槽、宿主限制，以及一条达到 `closed` 的命令级场景。示例 JSON 必须通过同版本 Schema 测试。

## 验收

至少验证：缺失/摘要不符的 Task Contract、未解析必填输入、节点字段丢失、非法后向依赖、重复节点、扇出预算、无匹配/多匹配分支、循环耗尽、结果端口错配、越权路径、缺失 Gate/Decision、Source 漂移、恢复和完整 `closed` Receipt。检查必须查看最终 Prompt 的 Task 摘要、已解析输入和结果合同。结构测试、合同测试和命令级合成闭环缺一不可；真实业务执行仍需单独授权。
