# 可组合流程与项目记忆改造方案（2026-09-19）

> 状态：此文保留改造前的设计基线与纸面验证。2026-09-19 已开始并完成首轮代码改造；实际交付、命令级准出和当前限制以[实现及准出记录](workflow-platform-implementation.md)为准。后续统一以[Harness Workspace 顶层边界设计](workspace-platform-design.md)取代本文按 Project 划分的归属模型。设计细节见[可组合流程抽象方案](workflow-composition-proposal.md)，原审查缺口见[设计审查](workflow-platform-design-review.md)。下文的“当前/尚无”均指改造前的审查时点。

## 一、目标与判断

目标是让现有和新业务流程都通过**流程定义 + 节点模板 + 来源/记忆/工具适配器 + 少量 Profile 策略**接入，复用已有的 Authority、Feature DAG、Lease、Attempt、重试、Gate、Evidence、恢复和宿主 Runtime。底座不内置 Engine、Collection、需求整理或知识问答的业务分支。改造完成时，现有 Engine/Collection 的新 Run 也必须走通用编译器，不能继续依赖各自硬编码的节点编排。

对“快速搭建”的验收定义是：当所需输入 Provider 和节点模板已存在时，一个新流程只需提交声明式定义、配置和针对业务验收规则的测试，无需修改 Kernel、调度器、持久化或宿主插件；单实例和多实例使用同一份定义。若流程需要全新的外部能力，例如多仓库只读检索，仍须先实现并批准对应适配器。

**当前结论**：两种目标流程都能映射到 Harness 的现有调度/持久化原语，但还不能配置后直接运行。基础缺口是通用流程编译器、版本化节点模板、多来源/多仓库 Source Manifest、跨 Run 的项目记忆与问答反馈合同；要真正执行，还须补齐类型化节点输出、运行中有界分支、Gate/Decision 等控制节点、跨 Run 资源准入、跨存储记忆提交及来源外发权限。现有执行授权和源码漂移检查围绕单一 `workspace.root/sourceDigest`，不能直接让 Agent 读取任意多个仓库。现有流程迁移是这项改造的必需交付，不是后续可选工作。

**现有流程的数量与边界**：Engine Delivery 和 Collection Batch Production 是两条独立业务流程，应分别有自己的 ID、版本、定义摘要、节点图与验收合同。中性 Feature Delivery 是第三份参考流程定义，用于验证平台的通用性，不代表 Engine/Collection 的共同业务流程。三者共用编译器、节点模板、调度与可靠性原语。`single/many` 只决定实例扇出与容量，不能替代节点顺序、Barrier、Gate 和 Decision 的业务差异。

## 二、改造边界

| 层 | 改造职责 | 保持现有职责 |
| --- | --- | --- |
| Workflow Definition | 声明节点、输入/输出端口、依赖、静态扇出、汇合、分支和关闭条件；绑定版本/摘要 | 不在配置中嵌入任意代码或工具命令 |
| Node Template Registry | 声明参数 Schema、执行类别、角色、来源权限、类型化 Result/Artifact 端口、验收/结果合同；按 ID/版本/摘要安装 | Feature 仍是 Agent 调度单位；Feature 内 Step 默认同一 Agent 串行 |
| Workflow Compiler | 确定性地把定义与输入编译为 Lifecycle Plan、Feature DAG、Gate/Decision 条件及受限 continuation；检查无环、权限、扇出预算和输出冲突 | Kernel 继续校验计划并以 expected revision、幂等 command ID 提交 Authority；条件分支不能靠任意脚本 |
| Source Manifest / Read Provider | 对每份文档、每个仓库分别固定来源、revision、内容摘要、只读范围和 Evidence；提供受限搜索/读取 | 输出仍进入有写入授权的受管工作区或 Artifact Store；不默认改业务仓 |
| Memory Spaces | 在独立 Control Root 按知识域、项目、流程、来源和会话隔离有证据的记忆；可选 Git 版本化导出 | Evidence 是原始依据，Authority 是唯一流程状态；模型总结和 Git 历史不是权威结论 |
| Instance Set / Fan-out | 以稳定实例键启动独立 Run，或在一个 Run 内按条目展开 Feature 分支；跨 Run 准入限制输出、仓库和 Provider 容量并聚合状态 | Run 是 Authority/准出边界；Feature 是调度边界，批次整体关闭不能拆散成互不相关的 Run |

Profile 不应被缩小为“一个节点一个 Profile”。Profile 仍表达整个 Run 的 `canDispatch/canClose/validateResult` 等跨节点规则；节点模板只规定单个工作单元。Agent 推理、确定性 Gate、用户 Decision 属于不同执行类别，编译器要保留这个边界。供应商 Runtime、Tool Broker、Source/Memory Provider 由获批准的 Extension 安装和固定；插件仅返回 Intent、Event 或 Receipt，不得直接改 Kernel Authority。

## 三、优先冻结的合同

1. **Workflow/Template 身份**：`id + semanticVersion + artifactDigest + schemaVersion`；一个 Run 固定完整定义及模板摘要。项目可批准多条 Workflow，但每次启动必须明确选中一条；修改定义只影响新 Run，不能让旧 Receipt 自动有效。
2. **Source Manifest**：每个输入包含 `sourceId/type/revision/contentDigest/accessScope/evidenceRef`；仓库另含 remote、commit 或工作树快照、可读路径和允许接收内容的 Runtime/模型范围。Run 固定组合摘要，同时保留每源摘要以支持选择性重验。多个仓库是各自固定的 revision 集合，不假设全局原子快照；兼容关系由显式约束验证，读取不得漂移到移动的分支头。输入文本一律作为不可信资料，不能成为对 Harness 的操作指令。
3. **Memory Space/Record/Query**：明确知识域、项目、流程、来源及会话作用域和读写权限；知识记录包含主题、主张、精确来源定位及摘要、依赖集合、原始 Evidence、产生者/验证者、状态和版本链。查询必须带 Workflow Ref、项目/访问域、Run 固定的空间修订与当前 Source Manifest，返回有效性、出处和记录摘要；未知依赖或来源变化时保守降级为待重验。
4. **记忆提交**：Agent 只能提出候选；验证通过后由受管写入路径以 expected revision 和幂等 ID 原子提交。事实、推论、用户确认的决定分类型存储。并发冲突保留两边证据，进入复核；不能按最后写入者覆盖。
5. **问答修订**：一轮提问对应不可变 `questionRevision`/Run；否定反馈产生下一修订和新 Run。临时排除记忆绑定问答会话、主张指纹和到期条件；已有持久知识确证错误时另写持久撤销/更正事件。
6. **上下文注入**：Prompt Codec 从不可变 Packet 装入经核验的记忆引用、证据摘要和临时排除记录，记录检索/截断策略与注入摘要。Operator 不能临时编辑完整 Prompt；重试和恢复能重现所用上下文。
7. **节点数据与控制**：Node Result 绑定模板/端口 Schema、Artifact Ref 和 Evidence；条件分支由纯规则读取已验证结果并有界追加后继工作。Gate/Decision 请求、等待、撤回、超时和恢复是独立控制合同，不作为 Agent Feature 的文本约定。
8. **跨域准入与提交**：Source/Memory 的来源权限同时约束检索和 Runtime/模型接收范围；多个 Run 的输出、仓库和服务配额由全局准入控制。记忆候选提升采用与已提交 Submission 绑定的持久 Effect/Outbox 和幂等 Receipt，崩溃后可核对重放。

记忆命中不等于答案正确。可确定的源码事实应由原文/代码定位和可重现检查支持；语义解释、需求取舍等按模板要求独立复核或用户确认。未经确认的答案可带证据返回，但不能升级为“已确认”的持久知识。

## 四、实施顺序

| 阶段 | 交付物 | 通过标准 |
| --- | --- | --- |
| A：合同与验证器 | Workflow/Node/Source/Memory/Instance 的 Schema、摘要、版本与错误码；类型化节点输出、控制节点、外发权限、多流程发现/选择和问题归属合同 | 非法依赖、循环、越权、摘要不匹配、输出冲突或流程歧义在 Run 创建前失败 |
| B：单源流程纵切 | 通用编译器、通用 Workflow Profile、静态扇出/汇合、有界 continuation、Feature/Gate/Decision 映射与等待恢复 | 纯配置复现中性 Feature Delivery；命中/未命中分支可确定性复现；Engine/Collection 旧计划仍可作为等价基线 |
| C：多源与记忆 | 多来源固定快照、Source Manifest、Memory Space Registry、按文件/对象失效的 Store/Query、Run 级记忆快照、受管 Outbox 与可选 Git 导出合同 | 相同来源的第二次运行复用已验证事实；未授权检索/外发被拒；局部变化选择性失效；崩溃后记忆提升恰好一次 |
| D：实例与反馈 | Instance Set、跨 Run 输出/仓库/Provider 准入与容量及公平调度、问答会话/问题修订、临时错误排除、持久纠错 | 多实例隔离、同输出不并发写且不会因长任务长期饥饿；否定反馈后不重复旧错误主张；新问题版本有新 Plan/Run 和完整审计链 |
| E：现有流程迁移 | Engine、Collection 与中性 Feature Delivery 的声明式定义/策略；显式流程路由和问题上报绑定；旧编译器与新编译器的计划及行为对照 | 全动作、质量回路、Gate/Decision、批次和恢复用例等价；新 Run 只走通用编译路径，问题记录有明确归属 |
| F：新流程准出 | 下述两个新流程的声明式定义、模板包、端到端合同测试、接入成本/记忆效果记录和使用文档 | 新增流程不修改 Kernel/调度器；记录复用/新增模板与人工接线步骤，通过来源漂移、恢复、权限、冲突及结果溯源用例 |

阶段 B 可以先使用单输出工作区。阶段 C 为多仓库检索提供经批准的只读 Provider/受管快照，不要求把多个代码仓库都当成输出工作区；若未来要让 Runtime 直接进入多个仓库，还须扩展执行 Grant、隔离与 `changedFiles` 核验合同。阶段 E 必须完成现有流程迁移；旧编译器在对照期间保留为基线，已创建的旧 Run 按其固定版本继续恢复/审计。切换只作用于新 Run，不能把旧结论按状态字符串升级，也不能因新方案通过而自动清理旧文件。

## 五、纸面搭建验证一：多来源需求与设计文档

**输入**：一组需求文档、若干只读代码仓库、一个有写入权限的文档输出目标；每个输入都有独立的 revision、摘要和允许读取范围。

| 节点模板 | 输入与输出 | 能复用什么 | 尚需什么 |
| --- | --- | --- | --- |
| 文档采集/规范化（按文档扇出） | 原文 → 带出处的需求事实 | Feature 并发、Evidence、结果校验 | 文档 Source Provider、事实 Schema |
| 需求归并 | 需求事实 → 规范需求、歧义清单 | Feature 依赖、用户 Decision | 归并模板与冲突处理规则 |
| 仓库检索（按仓库扇出） | 规范需求 + 仓库快照 → 符号/调用/实现证据 | Feature 并发、只读 Runtime/Tool Broker | 多仓库 Source Manifest、受限检索 Provider、记忆查询 |
| 影响映射 | 需求 + 代码证据 → 需求到实现/缺口映射 | DAG 汇合、Artifact 输入输出 | 映射模板、跨源引用校验 |
| 文档生成 | 映射 → 完整需求与功能细节文档、设计文档 | Feature 串行/并行约束、受管输出 | 输出 Schema/模板、实例命名空间 |
| 独立复核 | 两份文档 + 当前来源 → 一致性发现、修订建议 | Quality/Review、Gate、Finding | 文档质量规则与关闭 Policy |

**单实例**：一个功能需求对应一个 Run。**多实例**：多个功能需求各有独立 Run，Instance Set 只控制发车容量；共享未变化的只读来源索引和已验证知识，不共享未核验推论、Authority 或 Lease。两个实例写不同输出目录。若需求文件或相关源码变化，只重查受影响记录与文档章节；影响边界无法证明时扩大重验。

**搭建结论**：流程形状能直接映射到 Feature DAG 与 Profile 关闭规则。完成 A–D 后，新需求整理流程主要是配置和模板接线；目前缺少多源合同及检索/记忆 Provider，不能仅改配置实现真实的多仓库检索。

## 六、纸面搭建验证二：本地知识问答

**输入**：问题、项目及只读来源范围、问答会话身份；可选用户反馈。**输出**：带精确证据的答案，或明确的未知项与一个针对性澄清问题。

| 阶段 | 命中与分支 | 底座/新能力 |
| --- | --- | --- |
| 解析问题 | 固定本轮问题版本、实体、答案类型与范围 | 生命周期 Plan；问题解析模板 |
| 检索已确认知识 | 命中且来源/权限/相关性均有效 → 形成答案候选；否则继续 | Memory Query、Source Manifest 失效判定 |
| 补查代码与文档 | 针对缺口检索、读取、形成有出处的主张 | Feature/Tool Broker；受限多源搜索 |
| 核验并回答 | 确定性事实可自动核对；解释性结论需复核/用户反馈；证据不足则追问 | Gate/Review/Decision、Answer Receipt |
| 接收反馈 | 正确 → 将可复用主张提升为持久知识；错误 → 临时排除该主张并澄清 | Memory 提交/撤销、会话临时记忆 |
| 重走流程 | 用户补充信息形成新 `questionRevision`，重新编译新 Run | 新计划与 Run lineage；有界重试预算 |

临时排除记录只在当前问答会话及其后续问题修订中生效，并按 TTL/轮数到期；记录被拒绝的主张指纹、所用证据和原因。它防止同一错误答案换个措辞再出现，同时允许用户改变范围后重新评估。若被否定答案引用了已持久化的错误知识，要追加持久撤销/更正事件；会话结束不应让这条错误知识重新变得有效。

**搭建结论**：问答可使用同一 Workflow/Node/Memory 合同，无需另造问答专属 Kernel。当前尚无跨 Run 记忆查询、来源级失效、问题修订/临时排除合同，因此“命中直接答、未命中查源码、错了追问并避免重复”还不是现成能力。

“记忆命中/未命中”必须根据已验证的类型化检索结果走受限 continuation，不能把所有分支都预先编成必做 Feature，也不能让 Agent 自行决定跳过 Gate 或 Decision。节点产出的事实、引用、候选答案和文档都以带 Schema/Evidence 的 Artifact Ref 在后继节点间传递；自由文本 `summary` 不充当端口数据。

## 七、现有流程的必需迁移

从源码看，当前不是“一条固定节点图 + 单/多实例开关”：`engine-delivery`、`collection-batch` 和中性 `feature-delivery` 是三个 Profile；Engine/Collection 各有 `createLifecyclePlan` 编译器，节点顺序、动作分支与关闭条件写在代码中。目标是**一个通用编排合同、两条独立的版本化业务流程定义，以及一份中性参考定义**，而不是继续维护各自硬编码的计划编译器。通用节点模板可以复用，但不能让一条流程的审批或关闭规则隐式影响另一条。

| 配置 | 现有实际图与规则 | 迁入同一模型的方式 |
| --- | --- | --- |
| 中性 Feature Delivery | Feature DAG → Gate → findings/review → receipt | 最小交付定义；用依赖、必需 Gate/Decision 与关闭策略表达 |
| Engine Delivery | 需求接收 → 规范需求 → 版本规划 → 实现 → 范围决议 → 文档收口 → 质量 → 用户代码审核 → 交付；规范需求 Decision 与最终质量/Gate 必需 | 节点序列、可选动作入口、规范需求批准、质量修复/复查、文档与交付条件都声明化；运行目标通常是一个版本/功能，但实现节点仍可动态分解 Feature |
| Collection Batch | 每游戏规则 → 生产 → 质量 → 独立审核 → 接受；批次发车与前批关闭 Barrier、共享能力唯一 Owner、逐游戏三类验收和批次关闭 Decision | `forEach gameId` 在**同一批次 Run 内**展开 Feature 分支，显式声明共享能力依赖、批内冲突与批间 Barrier；所有游戏、质量/Gate/Decision 满足后批次整体关闭 |

所以单例/多例是**运行形态维度**，仍需标明扇出边界：多个独立需求可生成多个 Run；一个 Collection 批次的多个游戏当前共享批次准出，适合一个 Run 内多条 Feature 分支。若简单按游戏拆成独立 Run，会丢失批次关闭、共享能力归属和跨批次 Barrier 的语义。流程内容、审批、质量和实例数是可分别配置的维度，不能把后几项全部折叠进 `single/many`。

迁移步骤必须是可检验的：

1. 从旧编译器提取 Engine、Collection 的每个动作（`full` 及局部动作）和 selector 的代表性输入，固定旧计划的 Feature、依赖、允许路径、角色、Gate、Decision、质量根、stop condition、保护操作与来源/制品摘要，形成对照基线。
2. 用通用模板表达顺序、扇出、Barrier、共享 Owner、审批、质量 follow-up 和关闭投影；特殊业务数据放入配置/Descriptor，确需专用纯验证逻辑时放入已批准 Extension，并列出为什么通用 Primitive 不足。
3. 比较新旧计划的语义投影和调度轨迹：包括可发车条件、批内并发/冲突、动态分解、P0–P3 质量修复及复查、最终 Gate 新鲜度、用户 Decision、失败预算和结果 Receipt。Plan/ID 若必须变化，要明示版本边界，不能默默让旧 Run 继续用新定义。
4. 在只读对照及独立 Canary 通过后，将新 Run 入口切到通用编译器；旧 Run 继续按固定旧 Extension/Plan 处理恢复与审计。现有硬编码编译器退出新 Run 路径，旧代码与制品清理仍由用户决定。

**迁移完成的判据**：Engine、Collection 和中性参考流程的新 Run 都由同一个 Workflow Compiler 编译；Engine 与 Collection 分别拥有可独立升级、审查和回滚的 Workflow Definition；差异只见于各自定义、模板和受批准的策略/插件。任何流程语义变更都能通过对应定义的差异与计划摘要审查。两个新样板流程应在此基线上证明低成本接入。

## 八、多流程发现、启动和问题上报

现有 Codex 入口 `h:<project-alias> <action> <target> [preset]` 先按项目别名选择一个固定的 Profile/Extension，再由该 Extension 的 Command Manifest 解释动作。`h:report <project-alias>` 的 Issue Intake 也只包含项目别名、Project/Profile/Extension；它在 Registry 或 Authority 故障时仍可仅凭安装绑定上报。一个 Project 同时挂多条流程后，**Project Alias、Workflow ID、Run ID 必须是不同层次的身份**，不能继续靠动作名、目标格式或当前目录猜流程。

建议的身份链：

```text
ProjectAlias → ProjectId → WorkflowId@Version#Digest
                           → Action/Target/InstanceKey → RunId/PlanDigest
                           → NodeId/FeatureId/DispatchId
```

Project Descriptor/Workflow Registry 明确列出该项目允许的 Workflow ID、版本、完整制品摘要及其 Command Manifest/Extension/Profile 绑定。安装绑定只负责找到可信 Harness 和 Project；流程从获批准目录中精确选择。若只安装一条流程，可保留旧短命令作为兼容入口；一个项目有多条流程时，新的入口必须显式携带 Workflow ID，未知或含糊的 ID 在创建 Run 前拒绝。流程版本可由项目固定的活动绑定解析，并在计划和回执中显示；显式选择历史版本时也只能使用仍获批准的制品，不能按名称查找磁盘或隐式升级。

以下是**拟议命令形态，不是当前可执行命令**：

```text
h:flows <project-alias>                                      # 只读列出已批准流程、版本、动作
h:<project-alias> flow <workflow-id> <action> <target> [preset]
h:report <project-alias> [--workflow <workflow-id>] [--run <run-id>]
```

例如，同一项目绑定 Engine 和 Collection 时，启动语义分别是 `h:product flow engine-delivery full V3.8.4` 与 `h:product flow collection-batch full B1`。`flow` 是命令路由保留词，后面的 Action 只能来自选中流程的 Command Manifest。CLI/API 对应使用独立 `projectId`、`workflowId`、`action`、`target` 字段。`h:where` 保留为只读安装/项目绑定查询；`h:flows` 读取项目允许的流程目录并展示明确版本与摘要，不应发车。既有 `h:engine quality V3.8.4` 只在其安装绑定仍唯一对应一条流程时保留兼容，不可在多流程项目中默选默认流程。

编译后的 Command Intent、Lifecycle Plan、Execution Readiness、Authority 元数据、Receipt 与可见任务状态都要固定 Workflow ID、版本、摘要。逻辑任务键和新 Run ID 的派生必须纳入这些身份与 `instanceKey`，从而使同项目、同动作、同目标的两条流程不会互相续跑、复用旧 Receipt 或覆盖输出；旧 Run 保持原协议和键值，由版本化兼容路径恢复/审计。Action Execution Policy 也应按 `workflowId/action` 查找，避免不同流程恰好同名的 `full`、`quality` 共用错误的 Runtime/授权策略。

**问题上报**要与业务流程里的 Finding 分开：`h:report` 记录 Harness/集成/流程实现故障，质量 Finding 仍属于相应 Run。拟议 Issue Intake v2 增加 `scope`（平台、集成、项目、流程、Run/节点）、可选且有验证状态的 Workflow Ref，以及 Run/Plan/Node/Dispatch Ref；流程级问题必须带 Workflow ID，能核验时带版本/摘要。上报可按 Workflow ID、版本、失败码与节点筛选/归并；多个流程触发同一平台缺陷时可关联，但不能把一条流程的缺陷误记为另一条。

`h:report` 必须继续在 Registry、Descriptor、Authority 或某条 Workflow 损坏时工作：先使用安装时已固定的项目别名、Control Root 和入口；显式 `--workflow` 可作为用户提供的归属线索，无法核验的版本/摘要标为 `unverified` 并写入 `missingEvidence`，不能伪造。没有 Workflow ID 的上报归为项目/平台待分流，不根据当前目录、动作名或自然语言猜测。Issue 仍只落在 Control Root 的 `issues` 下，不启动 Run、执行 Gate 或自动提交 Git。

安装绑定自身损坏是另一层故障：当前 `h:report` 无法从损坏绑定推导可信入口。若要覆盖该场景，安装器需提供独立且完整性受检的维护绑定/入口；否则必须明确提示人工修复，绝不扫描磁盘猜 Control Root。Workflow Registry 的安装、激活、回滚及 Project 绑定切换也应原子化；活动版本变化只影响新 Run，旧 Run 继续固定旧制品。

## 九、记忆空间、共享边界与可选 Git 仓库

“通用记忆”不应等同于整个 Harness 的全局记忆。建议把共享范围建模为显式的 `MemorySpace`：每个空间有稳定 ID、所有者/知识域、成员项目和流程、可写主体、可读主体、来源范围、Schema/策略版本及内容修订。项目或流程只能读取被绑定并获授权的空间；不能因为同一用户、同一 Harness 安装或自然语言概念相似就跨空间检索。

| 记忆范围 | 适合存放 | 共享规则 |
| --- | --- | --- |
| 产品/知识域共享 | 已确认的业务术语、领域规则、跨前后端契约 | 前端与后端所属项目显式加入同一知识域后可读；跨项目并非默认共享 |
| 项目 | 项目特有需求、架构决定、依赖和交付约定 | 仅该 Project 及被明确授权的流程可读；若一个产品拆成前后端两个 Project，各自保留实现记忆 |
| 流程 | Engine/Collection 各自的流程知识、质量经验、问答模板线索 | 绑定 `workflowId`，不能把一条流程的做法当作另一条流程的事实或规则 |
| 来源/仓库 | 前端组件、后端服务、具体文件/符号的实现事实 | 绑定 source/repository ID、revision、文件摘要和访问范围；按来源变化选择性失效 |
| 会话/Run | 当前问答排除项、未确认假设、临时工作笔记 | 默认不跨会话；按 TTL/轮数清理，不能自动导出为持久知识 |

Engine 与 Collection 是没有业务关联的两个项目/流程，因此默认没有共同的产品知识空间；它们仅共用 Harness 的记忆存取机制。常规前后端协同开发可声明一个产品知识域，双方复用业务概念和接口契约；前端 UI/状态管理、后端 API/存储实现分别进入项目及仓库空间。若前后端在同一个 Harness Project 中，仍需按仓库来源区分实现事实；若分成两个 Project，产品共享空间须双向显式授权。每条 Memory Record 还要带 `originWorkflowId` 和可读范围：一个流程产出的事实只有经核验并明确提升后才能进入共享空间。更具体的记忆与共享记忆冲突时保留双方出处并进入复核，不按“项目优先”静默覆盖。

**配置与存放**：本地 Harness 配置应把 Project/Workflow 显式绑定到 Memory Space ID，再把 ID 解析为受控本地地址。V1.0.0 的写入边界要求 Harness 自有状态位于 Standalone Control Root 内，因此初版空间物理路径应是 Control Root 下的规范化、无 symlink/junction 的受管目录；用户给出的任意绝对路径或业务仓路径不能直接成为记忆库。若以后支持独立外部存储根，需先版本化扩展路径/授权合同。配置可选 `git.remote`、`branch` 和同步策略，但远端地址是分发目标，不替代本地 Memory Space 身份或权限。不同访问域的记忆不应混进同一个可远程读取的 Git 仓库。

**可选 Git 工作流**：每个需要审阅/同步的持久 Memory Space 可有单独 Git 仓库，导出经过确认和脱敏的结构化记录、来源引用、Schema 与清单；索引可重建，临时排除记忆、原始聊天、凭据及受限 Evidence 默认不导出。Git commit 是知识版本快照，push 是外部分发；两者都需各自明确授权，不因 Agent 回答正确而自动执行。未配置 Git 时，记忆仍在本地持久可用。导入、pull 或 merge 得到的内容视为待验证输入，须检查清单摘要、Schema、来源可达性、授权和冲突后再通过受管 Memory Store 提交；不能直接把 Git 工作树当作 Authority 或把外部提交自动升级为已确认事实。跨设备缺少原始 Evidence 时，记录保留出处但降级为待重验。并发写入使用 expected revision/幂等 ID，Git 合并冲突不能按最后一次提交覆盖知识事实。Git 导出不是 Authority/Evidence/未导出记忆的完整备份；灾难恢复需独立的受管备份与清单核验。

还需要在合同与验收中覆盖这些容易遗漏的情况：

1. **共享与撤权**：成员项目/流程退出空间后立即不能检索；已生成的 Run 保留审计引用，但新 Dispatch 不再注入该空间内容。已发给活跃 Agent 的内容无法收回，撤权策略须明确何时中断并收容活跃 Lease、记录已披露范围。共享知识进入另一项目前要重新核验来源访问权。
2. **知识类型**：区分业务事实、代码事实、设计决定、流程经验和临时假设；流程经验不能更改已批准的 Workflow Definition，旧用户 Decision 不能被复用成新 Run 的自动批准。
3. **来源漂移**：项目/仓库重命名、分支切换、接口契约变化、文档版本变化和模板升级都要进入影响分析；缺少可证明依赖时保守重验。
4. **安全与保留**：写入前做敏感信息检查与访问标记，派生记录继承最严格来源限制，Git 导出再做一次；即使已验证事实，记忆文本在 Prompt 中仍是数据而非操作指令。定义保留期、撤销/更正、归档和显式删除规则。删除记忆不能删除原始 Authority/Evidence，也不能绕过用户对旧文件清理的决定。
5. **检索质量**：记录命中、被拒原因、来源新鲜度、最终答案是否被用户纠正及节省的重复读取范围；索引缺失、损坏或版本不兼容时退化为原文检索，不能把相似文本当作确证知识。
6. **可复现性**：Run 固定可读 `memorySpaceId/revision` 与查询策略，每个 Dispatch 再固定命中记录及摘要；共享空间更新只影响后续 Run。本 Run 的新知识通过 Run Artifact 传给后继节点，不能让空间更新悄悄改变已生成 Prompt 或旧验收结论；确需刷新则另建有审计关联的 Plan/Run。

## 十、最终验收矩阵

1. 同一流程定义可启动一个或多个独立 Run；Run 内条目扇出也受 Feature 依赖与容量约束。两种扇出方式的 Authority/关闭边界明确，Collection 批次仍整体准出。
2. 两次相同来源的分析复用有证据的知识；源码局部变化只使依赖它的记录待重验；无依赖证明时不能静默复用。
3. 跨仓库搜索只读取已授权仓库与路径，结果能追溯到仓库 revision、文件摘要和定位；输出写入受管目标。
4. 问答从有效记忆命中给出有出处的答案；失效或未命中时补查；用户否定后新 Run 不重复被排除的主张。
5. 并发实例提出冲突知识时保留双方 Evidence 并进入复核；错误的持久知识能撤销，临时错误会按期清除。
6. 重试、ordinary resume 和 hard recovery 维持原有 Authority/Evidence 边界；新流程定义、来源、记忆策略变化都不会借用旧准出 Receipt。
7. Engine、Collection 与中性 Feature Delivery 的新 Run 均通过同一个通用编译器；全动作/selector 的计划语义、质量、Gate、Decision、批次 Barrier、共享 Owner 和恢复行为通过对照，旧 Run 不被新定义改写。
8. 两个新样板流程接入期间不修改 Kernel、底层调度器或宿主适配器；若必须修改，记录缺失的通用合同并先补到平台层。
9. 同一 Project 同时安装 Engine、Collection 和新流程时，列表、启动、状态和 Issue 都显示准确 Workflow 身份；同名 Action/Target 不串 Run 或授权策略；缺失/含糊流程拒绝启动，Registry 损坏时仍能上报带缺失证据说明的问题。
10. Engine 与 Collection 在无共享绑定时互相查不到记忆；前后端经明确绑定后共享产品概念，但各自的实现事实仍按项目/仓库权限隔离；流程专属记忆不会自动提升为通用记忆。
11. 未配置 Git 时本地记忆仍持久；配置后只导出允许共享的已确认记录，commit/push 分别按授权执行；导入冲突或缺失原始证据时保持待验证，不能覆盖当前知识或 Authority。
12. 问答命中/未命中分支由已验证节点结果确定性展开；Gate/Decision 可等待、超时和恢复；节点 Artifact 有类型、来源、摘要与消费方校验。
13. Submission 与 Memory Store 写入之间任一点崩溃后，未决 Effect 可恢复且不会重复提升错误答案；Run 内记忆快照稳定，跨 Run 的更新需新 Plan 才可见。
14. 两个 Run 争用同一输出、仓库或 Provider 配额时只允许安全的准入结果；受限来源和派生记忆不会被送往未获授权的模型/工具。
15. 多仓库输入固定独立 revision 并验证组合约束，分支头漂移、来源撤权或证据缺失都能被发现；Workflow/Memory Schema 升级可回滚，旧 Run 继续按旧版审计。
16. 两个新流程交付时记录新增定义、模板、Provider、配置步骤和合同测试，并用重复问题/源码变化样本评估记忆命中、错误复用与重复读取量；不能只因未修改 Kernel 就宣称接入成本低。

本轮只交付方案和纸面验证，不启动两个真实流程、安装新插件或修改实现代码。
