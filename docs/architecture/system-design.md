# Agent Harness 整体设计

**状态：** V1.0.0 当前架构。本文是运行时、权威、工作区、资源和 Flow 包的唯一现行整体设计。业务流程自己的参数与节点合同由各自设计文档定义。

## 1. 分层与依赖

```text
宿主与 CLI → application 装配 → platform 合同 / 中立 flows → kernel
                                  ↘ flow-kit 共用原语 ↗
Legacy consumer shim ────────────────────────↑
```

`kernel/` 只处理 Authority 事务、状态机、Evidence、Receipt、工作图和恢复不变量，不识别业务项目、工具、模型或宿主。`platform/` 定义 Workflow 编译/协调、Workspace Registry、Resource Broker、Extension Registry、Plugin Host 和通用恢复。`flow-kit/` 只容纳至少两条流程确实共享的语义。`flows/<flow-id>/` 拥有中立流程自己的节点、图、策略与合同。`integrations/legacy-consumers/` 可以依赖中立 Flow 工厂并固定旧 ID、命令和领域规则；中立 Flow、Platform 与 Kernel 不得反向依赖 Legacy。`application/` 组合已批准制品和服务，`interfaces/` 与 `integrations/` 把命令及宿主操作接到这些服务。Flow 不直接写 Authority；插件返回 Intent、Event 或 Receipt，Kernel 再验证并提交。

`createHarness()` 保持公共装配入口。默认装配只包含中立 Core、Feature Profile 与参考插件；业务流程、供应商 Runtime 和 Legacy 能力必须通过 Extension Registry 安装批准并固定完整制品摘要，或由开发态嵌入方显式提供。既有包子路径和命令别名由公开 facade 保持兼容。

## 2. Authority 与运行时

Run 是一次带 Workflow ID、版本、制品摘要、Workspace 修订、成员项目范围、Epoch 和 Generation 的执行。Plan 在启动前固定流程动作、来源、执行方式和输出槽。预检在写入 Run 前核实制品、路径、权限和宿主能力。Dispatch 固定 Feature、Prompt、路由和来源摘要；Runtime 返回结果后，由结果合同、Gate 与用户 Decision 决定能否推进。正式质量准出要求当前周期 P0–P3 全部关闭。

所有写命令使用 `expectedRevision`、幂等 `commandId` 和原子提交。Agent 对话、模型输出、插件状态不是权威状态。Evidence 和 Receipt 固定版本、来源与内容摘要。普通继续废止旧 Transport；硬恢复验证 Capsule 后建立新 Epoch，旧结论只作为审计输入。Extension 或 Workspace 修订变化不静默改写已启动 Run。

同一 Project、Workflow 和目标版本的跨 Run 质量状态由 `QualityTargetSnapshot` 表示。它不是第二套可写真相，而是从终态 Run Authority、Submission、Finding、Evidence 和 Receipt 确定性重建的内容寻址投影。第一次进入版本生命周期时 revision 为 0、Finding Ledger 合法为空；开发、测试和审查产生的 Finding 随 Run Authority 持久化，后续 Plan 自动继承。`QualityInventorySnapshot` 固定目标 revision、目标摘要与当前 Source digest；源码变化使旧 clean review 失效，但不删除旧 Finding、Evidence 或历史结论。Project Descriptor 只声明长期质量策略，不保存版本专用 Finding 清单。

交互式执行要求可信宿主原生提供用户可见子 Agent、检查、等待、结果、取消、Host Effect 对账和 Lease 确认。适配器不得用内存状态合成 `verified`、`completed` 或 `success`；任一能力缺失即拒绝生命周期执行。Codex 当前提供已验证宿主链路；OpenCode 与 VS Code 渠道仅提供初始化、只读状态/界面和原生能力注入点，在没有完整原生回调时明确返回 unsupported。显式无人值守执行须同时满足 Descriptor 允许策略、可信用户约束和命令级 Execution Grant；启动进程还须持有 Core 的 launch capability。缺少能力时预检拒绝。确定性 Gate 使用声明的执行类别和受管输出预算。

## 3. Workspace 与资源

Workspace Descriptor 是新工作区的配置来源，独立于版本化 Workflow Definition。它绑定精确的 Workflow ID、版本、制品摘要、Extension、Profile，以及成员项目、默认项目范围、来源、执行目标和资源。一个工作区可安装多条流程；不同工作区可复用同一流程。别名、成员项目和执行目标经 Registry 唯一性/冲突校验。注册、回滚要求修订、命令 ID 和 Authority Decision；回滚以旧内容创建新修订。

工作区通用资源与项目资源分开；流程、来源和会话还能进一步限域。首个 Resource Provider 是版本化的本地记忆库。候选知识带来源依赖与覆盖摘要，经核验后成为可复用记录；来源增加、变更或撤权使受影响记录进入复核或拒绝访问。问答会话的错误候选可保留为临时排除记录，避免同一轮重复给出错误答案。记忆库可以按明确导入/导出流程进入 Git；导入内容先是未核验状态。未来其他资源沿用 Provider 合同、作用域、版本与权限校验，不改变 Workspace 与 Kernel 边界。

业务仓默认不驻留 Harness 实现或运行状态。项目可以保存一个项目自有、声明式的 `harness.json` 作为接入意图；控制根保存其编译后的 Sealed Descriptor、Registry、Authority、Evidence、Cache 与 Recovery。业务仓仍只是受限 Source 或 Execution Target。Source Manifest 固定在 Plan/Run 中，每次实际读取仍核对当前授权。增仓生成新 Workspace 修订及来源覆盖摘要；旧 Run 保留原快照，撤权阻断后续 Dispatch/读取。

## 4. Flow 包设计规范

每条 Flow 在 `src/flows/<flow-id>/` 采用相同基础结构：

```text
index.mjs                 稳定公开入口
extension.mjs             版本化 Extension Pack
planner.mjs               动作与输入到确定性 Plan
graph/definition.mjs      节点、依赖、扇出与汇合
nodes/<stage>/<node>.mjs  按本流程阶段组织的节点声明
contracts/index.mjs       输入、节点结果与输出合同
policy/index.mjs          Profile、Gate、Decision、关闭策略
commands.mjs              暴露命令时存在
```

条件分支放在 `graph/branches.mjs`；个性节点可继续拆文件。小流程不创建空目录。`graph/` 只组合节点，节点声明输入映射、来源权限、输出端口、证据和可验证的结果条件；Agent 推理由 Runtime 执行。静态图只能向前依赖。通用循环由带类型化停止条件、`maxIterations` 和耗尽策略的 repeat continuation 逐轮展开为新 Feature，Authority 中不得出现循环 DAG。流程不能导入其他流程的 `nodes/`、`graph/` 或 `policy/`，也不能导入 `integrations/legacy-consumers/`。至少两个流程共享且合同语义相同的能力才进入 `flow-kit/`。Workspace 参数只能填流程已开放的槽，不能改变已发布节点顺序、分支、Gate 或关闭规则。

每条流程必须有 `docs/flows/<flow-id>/design.md`，记录用途、动作、输入输出、节点与分支、结果合同、来源/资源权限、策略与关闭、恢复、可配置项和命令级闭环。流程代码与文档同版演进。制品变更产生新摘要，经批准安装和 Workspace Binding 切换；旧 Run 保留原身份。

## 5. 接入与验证边界

新业务方先定义 Flow Extension 与节点结果合同，再注册 Workspace 的项目、来源、执行目标和资源，安装/绑定制品并配置 Runtime。CLI 或宿主命令必须解析为唯一 Workspace + Workflow；多流程时显式选择。命令级准出从解析开始，经历 Plan、预检、Run、Dispatch/Submission、Gate/Decision，最终检查 `closed` 与回执。测试与 Schema 负责静态和局部合同；完整运行负责跨层闭环。真实业务质量、远端发布和旧状态切换由独立 Gate 批准。

单项目接入以项目仓内 `harness.json` 为公开输入，经 Core InitPlan 编译、外部 Decision 批准后写入控制根 Registry。CLI、Codex、OpenCode 和 VS Code 只提供同一初始化合同的适配入口。`source-link` 开发模式分别固定 Runtime 与支持文件摘要并保存 Runtime generation。变更按 H0–H4 分类：H0 与仅影响未来编译结果的 H1 可以留下 Patch Receipt 后继续当前已冻结 Run；Profile、Planner、Gate、运行时、Kernel 或 Authority 变化不能静默注入旧 Run，按等级要求新 Run、迁移或新 Release。项目 Run 始终无权修改 Harness，修复在独立 maintenance 上下文完成。完整字段和判定见[配置 API](../reference/configuration-api.md)。

## 6. 渠道制品

通用 Harness npm 包与宿主插件按渠道独立打包。Core Release Manifest 和 SBOM 只枚举通用 npm 包；该包保留已公开的 Codex Runtime/Extension API，但不包含 Codex 宿主插件目录或本地 marketplace。Codex 渠道包单独列出插件文件摘要及精确的 Core `packageDigest`；安装或组合验证必须拒绝摘要不符的 Core。渠道命令、产物路径和本机安装流程见[渠道打包](../reference/packaging.md)。未来宿主须有自己的打包入口、清单和安装验证，不复用 Codex 发布命令来隐式选择渠道。
