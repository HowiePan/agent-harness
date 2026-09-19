# 可组合流程抽象方案（2026-09-19）

> 状态：设计提案，尚未实现。当前代码已冻结；本文不改变 V1.0.0 合同、命令或运行行为。尤其不能把下文的示例配置当作当前可执行的配置文件。

统一的改造顺序与两个新流程的纸面搭建验证见[可组合流程与项目记忆改造方案](workflow-platform-refactor-plan.md)。

## 结论

可以在现有 Harness 底座上实现可配置的流程，并让同一流程按单实例或多实例启动。现有通用能力已经包含 Feature DAG、依赖和冲突调度、Lease/Attempt、失败重试、Gate、Evidence、Authority、恢复及 Extension Registry。需要新增的是**流程定义到当前执行原语的可信编译层**、多来源/多仓库输入的身份与快照合同，以及跨 Run 可检索、可验证失效的项目记忆。

“单项目/多项目”不能只改一个并行开关。实例数量是启动与容量策略；项目工作区、权限、共享资源、批次 Barrier 和关闭条件仍是独立语义。Collection 的批次限制不能因为实例并行而消失。一个需求涉及多个代码仓库，也不必把这些仓库各自变成一个 Harness Project：它们可以先作为同一流程实例的多个只读、可追溯输入；真正跨项目的 Authority 协调则另行建模。

## 现状与缺口

| 层 | 当前已有 | 需要补足 |
| --- | --- | --- |
| 执行底座 | `Feature` 是 Agent 调度单位，Feature 内 Step 默认同一 Agent 串行；DAG 依赖、冲突键、输出 Artifact、重试次数可声明 | 不需要重新写调度器；需要编译器把流程节点映射为现有 Feature/Gate/Decision 等执行原语 |
| 生命周期计划 | Extension 的 `createLifecyclePlan` 是纯计划操作，生成带摘要的 Run 和 Feature 图 | Engine/Collection 的节点顺序、分支和扇出仍写在专用编译器中，尚无通用流程定义文件或编译器 |
| Profile | Run 级的 `validateConfig`、`canDispatch`、`canClose`、`project`，可选 `validateResult` | 不适合让每个节点都成为一个完整 Profile；需要更小的节点模板及节点结果合同 |
| 输入 | Project Descriptor 目前只有一个 `workspace.root`；Run 的 `sourceDigest` 和执行授权围绕一个工作区快照 | 需要多来源文档和多仓库的独立快照、访问范围、内容摘要及组合摘要 |
| 记忆 | Evidence Store 持久保存 Run 证据；Gate Cache 按完整键复用通过的确定性检查 | 缺少跨 Run 的项目知识索引、来源级失效、版本冲突处理和按需检索 |
| 启动 | 同一底座能运行不同 Project/Run，Feature 可并发 | 尚无通用的实例集合定义、扇出上限、实例级去重及批量完成投影 |

对应实现位置：`src/kernel/work-graph.mjs`、`src/lifecycle-command-plan.mjs`、`src/profiles/registry.mjs`、`src/consumers/cardworld-engine.mjs`、`src/consumers/tabletop-collection.mjs`、`schemas/project-descriptor-input.schema.json`。现有 `src/workflows/primitives.mjs` 只提供少量 Barrier/Approval/Artifact 等辅助函数，不是流程 DSL。

## 建议的四层合同

1. **Workflow Definition**：版本化、带摘要的声明式 DAG，定义节点、依赖、输入输出端口、扇出、汇合、关闭条件。只使用已登记的节点类型与有限的表达式；配置本身不能执行任意代码、调用工具或修改 Authority。
2. **Node Template**：可复用的节点类型和参数 Schema，声明执行类别、输入输出 Artifact Schema、角色、允许访问的源、验收条件及结果校验。Agent 推理节点编译为 Feature；确定性检查编译为 Gate Recipe；用户批准编译为 Decision 条件。多个小 Step 如需同一 Agent 连续处理，仍编译进一个 Feature。节点模板不直接成为 Kernel 插件，也不直接提交状态。
3. **Workflow Profile/Policy**：Run 级投影与调度/关闭约束，如 Barrier、质量回路、必需 Gate 和 Decision。通用流程可有一个声明式 Profile；特殊流程仍可提供已批准的 Extension Profile。Profile 负责跨节点规则，节点模板负责单节点输入、输出与验收。
4. **Instance Set / Run**：启动时把输入集合实例化。单实例和多实例共享同一 Workflow Definition；每个实例有稳定 `instanceKey`、单独 Run/Authority/Evidence、源快照和输出命名空间。集合层控制 `maxParallel`、去重、失败汇总与总完成投影，但不绕过任何实例或项目的 Gate。

实例扇出与 Run 内条目扇出要分开：多个独立需求适合多个 Run；Collection 同一批次中的多个游戏共享批次关闭条件，适合在一个 Run 内展开多个 Feature 分支。Engine 与 Collection 是两条独立的版本化业务流程，中性 Feature Delivery 是参考流程；它们的新 Run 共用通用编译器，但各自定义节点和审批规则，不能只用 `single/many` 覆盖业务差异。迁移要求与对照验收见[改造方案](workflow-platform-refactor-plan.md)。

建议新增一个可信的 `compileWorkflow(definition, invocation, project, sourceManifest)` 纯计划操作：先解析并固定 Workflow/Template/Extension 的 ID、版本和摘要，验证端口类型、依赖无环、扇出上限、路径权限与输出冲突，再确定性地产出当前 `Lifecycle Command Plan` 可接受的 Feature 图及 Gate/Decision 约束。编译结果绑定定义摘要、实例键、输入清单摘要、Harness/Extension 摘要及执行策略。节点的动态扩展也只能以受控 Intent 追加有界 Feature，并经相同校验与 Authority 命令提交。

插件边界不变：Runtime、Tool Broker、Artifact Provider、Gate Executor 通过已批准 Extension 接入，只返回 Intent/Event/Receipt；Kernel 仍只认经过校验的命令和 Evidence。重试、Lease、幂等 command ID、expected revision、原子提交与恢复继续由底座负责。节点级重试策略只是在现有 Attempt/预算机制上声明参数；重试不能改变已固定的节点定义或输入快照。

## 多来源与多仓库输入合同

每个输入应有 `sourceId`、来源类型、只读访问范围、版本/修订、内容摘要、采集时间和可引用的 Evidence。仓库输入另有 remote、commit、工作树状态和允许检索路径；文档输入另有 Provider、对象版本和媒体类型。Run 固定 `sourceManifestDigest`，并保留各源独立摘要；任一源变化需产生新的输入清单或显式重基，旧检索结论不得直接升级。输出文档放在受管理且有写入授权的目标工作区或 Artifact Store，按实例命名，附需求来源、代码引用、缺口及不确定项。跨仓库搜索默认只读，且每个仓库分别授权和限定范围。

现有单一 `workspace.root`、`sourceDigest`、执行 Grant、Gate 的工作区漂移检查和 `changedFiles` 核验都按一个工作区设计。因此**不能仅凭 YAML 增加多个仓库路径就宣称支持可信的多仓库执行**。第一阶段可将经批准的外部源通过 Artifact Provider 固定为只读输入，再在现有单一输出工作区执行；完整多根工作区访问需要扩展源清单、执行授权、隔离 Runtime、Gate 与结果核验合同。

## 跨会话项目记忆

需求分析会多次读取同一批文件。要减少重复阅读，记忆应是**从来源和证据派生的可检索知识索引**，而不是聊天记录的自动摘要。当前 `EvidenceStore` 的记录绑定 `projectId/runId/epoch/generation/sourceDigest`，适合保留原始结果和审计依据；`GateCache` 只缓存通过的确定性 Gate。两者都没有提供跨 Run 的知识查询和按文件变化选择性失效。记忆服务应位于独立 Control Root，业务仓仍无需驻留 Harness 数据。

建议把记忆分为三类，并区分可信程度：

| 类别 | 内容 | 复用规则 |
| --- | --- | --- |
| 来源索引 | 文档目录、文件摘要、符号、接口、调用关系、搜索范围与出处 | 依据固定来源版本可重复读取；只存索引仍需能打开原文 |
| 有证据的事实 | 某需求原文、代码行为、配置约束、已确认的设计决定 | 每条记录附精确来源和 Evidence；来源未变且依赖闭包仍有效时可复用 |
| 推论与工作笔记 | 影响分析、疑问、候选方案、Agent 判断 | 标明作者/方法/置信与待验证状态；检索到后只能作为待核对线索，不能自动变成需求事实或准出结论 |

最小 `MemoryRecord` 应包括：稳定 `memoryKey`、类型与 Schema 版本、项目/仓库/文档及访问域、主题（文件/符号/需求 ID）、规范化内容、`sourceRefs`（路径或对象 ID、revision、内容摘要、定位锚点）、跨文件/跨文档依赖、产生它的 Run/Feature/工具或模板版本、原始 `evidenceRefs`、状态、创建与核验时间、前驱/替代记录。记录正文不可原地覆盖；新分析追加新版本，索引指针用 expected revision 和幂等 command ID 更新。并行实例给出不一致结论时同时保留证据与冲突状态，由复核节点或用户 Decision 解决，不能按“最后写入者”覆盖。

**写入路径**：采集并固定 Source Manifest → 从有证据的节点结果提取候选记忆 → 校验 Schema、来源权限、引用锚点和内容摘要 → 对事实做原文/代码核验，对推论保留未验证状态 → 持久化内容寻址记录与索引 Receipt。Agent、Memory Provider 和检索插件都只能提出候选或返回 Receipt，不能修改 Kernel Authority。记录被接受为记忆，也不代表 Feature/Gate/Decision 自动通过。

**读取路径**：新 Run 固定当次 Source Manifest 和记忆查询策略；在编译/Dispatch 前按项目、需求、仓库、文件/符号、权限和当前来源摘要检索。先返回短摘要、证据链接、状态和精确定位；确需细节时再展开原始片段。由 Prompt Codec 从不可变 Packet 确定性地装入选中的记忆引用与预算，不允许 Operator 在发车时临时改写 Prompt。检索排序与截断策略、命中记录的 ID/摘要、查询摘要、来源版本和注入内容摘要都进入 Dispatch/Evidence，保证重试与恢复时能重现上下文。没有命中或验证不通过时读原始来源，不能凭模型“记得”补齐。

**失效与纠偏**：优先以文件/对象内容摘要及显式依赖闭包判断，而非只用整个仓库摘要；只要依赖文件、引用的需求文档、接口版本或模板规则改变，关联事实就进入 `needs-revalidate`，不能作为当前事实注入。删除、重命名、访问权变化和来源不可达要有明确状态。没有完整依赖声明的广域推论保守地随相关来源快照变化而失效。重验证通过后产生新记录，旧记录留作历史审计。若发现旧记忆错误，写入纠错/撤销关系并让后续查询排除旧结论；已经生成的文档需按影响关系触发重检，不能仅更新索引。

**共享边界**：同一项目的不同需求实例可共享已验证的只读来源索引和事实；实例自己的任务假设、未确认需求和草稿默认隔离。跨项目共享须分别满足来源授权和记录访问域。检索与记忆数据不应改变 Source Manifest 的原始输入身份；它们作为带版本和摘要的辅助上下文单独固定。记忆被清空时应退化为重读来源，不能使 Authority 或原始 Evidence 消失。

多个流程共存时，通用记忆仅在显式绑定的产品/知识域内共享；项目、流程、仓库与会话记忆分别限定作用域。可选 Git 仓库及本地地址约束见[改造方案的记忆空间章节](workflow-platform-refactor-plan.md#九记忆空间共享边界与可选-git-仓库)。

对示例流程，第一次分析先建立需求文档索引、仓库结构与关键符号记录；后续需求先检索相关记录，只重读命中范围中已变化或尚无证据的文件，再更新影响映射。这样能节省重复扫描，同时将不同会话的判断差异显式暴露为待复核冲突。仅“保存上一轮总结”无法保证准确性，也无法安全地跨源码版本复用。

## 本地知识搜索与问答流程

同一记忆底座可以服务于问答式 Workflow：用户提出问题，Harness 在项目许可范围内检索本地持久知识；有足够且仍有效的证据就组织答案，没有则按问题检索需求文档和代码，验证候选答案，再回答。它不需要把问答逻辑写进 Kernel，也不需要把所有聊天内容永久存成知识。知识记录与索引保存在 Standalone Control Root；访问原始仓库和文档仍按 Source Manifest/权限合同进行。

建议的流程节点及分支如下，均为目标设计，当前尚无可执行配置：

1. **解析问题**：固定原文、问题版本、项目/仓库范围、期望答案类型、用户给出的约束，并产生查询摘要。含糊到无法定位时先提出具体澄清点。
2. **检索记忆**：按语义与结构线索查找有证据的知识记录，核验访问权、来源版本、依赖闭包、状态及是否确实回答了本题；只命中相似措辞不能判定“已有答案”。
3. **补查来源**：若记忆不足或过期，以问题中的文件、符号、需求 ID、调用关系为线索检索当前代码/文档；先窄范围读取，再按证据扩展。结果带仓库、revision、文件定位和摘要。
4. **形成并核验候选答案**：把回答拆成可核对的主张，逐项绑定原文或代码证据；可确定的事实用确定性检查验证，行为解释/设计判断按流程配置引入独立复核或用户确认。证据不足时明确未知部分并追问，不把猜测说成事实。
5. **回答与反馈**：给出答案和关键出处。已验证、可复用的主张可提交为候选持久知识；用户确认、明确的验收规则或独立复核通过后才提升为已确认知识。用户否定答案时记录反馈原因，撤销此次候选的准出，再提出针对性澄清问题。
6. **按修订后的问题重跑**：用户补充信息形成新的 `questionRevision` 和新的不可变 Run/Plan，沿用原问题与反馈作为输入，并带入本轮排除记录；不修改已经固定的旧 Dispatch/Prompt。问答会话的关联身份仅用于追踪修订和临时记忆，不能成为第二套 Authority。

这里的“答案正确”必须有明确判定来源：例如可重现的源码事实检查、已批准的规范、独立审核，或者用户反馈。用户没有确认时，可以返回附证据的答案并标记为待确认；不能因 Agent 自评正确就写成已确认的持久知识。已确认的知识最好拆成可复用的事实/决定及其证据，再用问题的不同表述指向这些记录，而不只保存整段问答文本。

### 错误答案的两种记录

| 记录 | 保存范围与期限 | 用途 |
| --- | --- | --- |
| 临时排除记忆 | 当前问答会话及其后续 `questionRevision`，可配置 TTL/轮数；会话结束后清理 | 保存被否定的主张指纹、所用证据、原问题、反馈原因与澄清结果。下一次检索/生成时排除同一主张或同一失效证据，防止换个说法重复给出旧错误答案 |
| 持久纠错事件 | 仅当错误暴露已持久化知识本身不成立时，写入原记录的撤销/更正关系及 Evidence | 让未来所有会话都不再把该旧记录当作有效知识；它不是把本轮错误问答永久保存为一条新的“反向知识” |

临时排除记录也应有稳定指纹、作用域、问题版本、来源版本、原因和到期条件。它只用于指导当前会话重新检索，不能替代源码证据，也不能无限积累。若用户只是改变提问范围，系统要重新评估先前否定的是哪一项主张，不能粗暴屏蔽整个主题。若重新检索仍找不到可靠答案，应报告未解决并等待新的信息；重试次数由工作流预算限制，不能无限循环或反复问同一个问题。

实现上，问答的“重走”是有界的**新问题修订与新 Run**，不是在 Feature DAG 中添加回边。记忆检索和候选写入由可插拔 Provider/节点模板实现，返回可验证的 Receipt；Run 的问答状态、用户反馈 Decision、重试预算和最终答案 Receipt 仍由现有 Authority 语义约束。Prompt Codec 应把本轮排除摘要与有效知识引用确定性地装入 Packet，保证新 Run 不会意外重用被否定的回答。

## 示例：需求与设计文档流程

以下仅展示目标形态，并非现有 Schema 或可直接运行的命令：

```yaml
workflow: requirements-and-design@1.0.0
inputs:
  requirementDocs: document-set
  repositories: repository-set
nodes:
  - id: normalize-requirements
    template: document-extraction@1.0.0
    forEach: requirementDocs
    outputs: [source-facts]
  - id: reconcile-requirements
    template: requirement-reconciliation@1.0.0
    needs: [normalize-requirements]
    outputs: [canonical-requirements, open-questions]
  - id: inspect-repositories
    template: scoped-code-research@1.0.0
    forEach: repositories
    needs: [reconcile-requirements]
    outputs: [code-evidence]
  - id: map-impact
    template: requirement-code-mapping@1.0.0
    needs: [reconcile-requirements, inspect-repositories]
    outputs: [impact-map]
  - id: write-requirements
    template: requirements-document@1.0.0
    needs: [map-impact]
    outputs: [requirements.md]
  - id: write-design
    template: design-document@1.0.0
    needs: [write-requirements]
    outputs: [design.md]
  - id: review
    template: independent-document-review@1.0.0
    needs: [write-requirements, write-design]
    outputs: [review-findings]
completion:
  require: [all-features-complete, review-findings-closed, output-evidence-valid]
```

同一需求的多份文档可以并行提取；多个仓库可以在各自只读授权下并行检索，再在 `map-impact` 汇合。若每个需求需要独立产出两份文档，则启动多个实例，每个实例有自己的输入集合、Run 与输出目录；集合层限制并发，避免公共检索服务或仓库访问超额。若多个需求共享同一份源快照，可共享不可变采集 Evidence，但不得共享 Authority、Lease 或未经验证的推理结论。

上例的 `normalize-requirements` 与 `inspect-repositories` 可先查询记忆索引；命中有效记录时复用带出处的事实，未命中或失效部分继续采集。`map-impact` 与文档审核阶段可产生新的候选记忆，但最终文档仍需按当前输入清单核验。

## 实施顺序与验收边界

1. **合同冻结**：定义 Workflow Definition、Node Template、Source Manifest、Instance Set、Memory Record/Query 的 Schema/版本/摘要及错误码；明确端口类型、静态/动态扇出、权限、记忆失效与升级规则。
2. **通用编译器**：实现声明式 DAG 到现有 Feature/Plan 的确定性编译，先覆盖单工作区、静态扇出、Agent Feature、已有 Gate/Decision；保留现有 Engine/Collection 编译器，做等价计划对照后再选择迁移。
3. **输入、记忆与实例层**：接入只读文档/仓库源的独立快照和 Evidence；先实现有证据的索引/事实存取、精确命中与保守失效，再接入选择性重验证；实现单实例、多实例、容量限制与集合投影。完整多工作区执行须单列合同升级与安全验证。
4. **现有流程迁移与新样板准出**：先将 Engine、Collection 和中性 Feature Delivery 的新 Run 入口迁至通用编译器，以旧计划与行为对照证明等价；再用“需求文档 + 多仓库检索 → 需求细节文档 + 设计文档”及“本地知识检索 → 补查源码 → 核验回答 → 反馈修订”两个样板验证低成本接入、并发、源漂移、记忆命中/失效/冲突、临时排除及持久纠错、失败重试、恢复、权限越界、输出冲突、Gate 和结果溯源。

准出条件是：同一版本化定义在单实例和多实例启动下生成可重现计划；不同源的摘要和引文可追踪；第二次运行能复用未变来源的有证据记忆，修改一个文件只让受影响记录失效，缺少依赖证明时保守重验；冲突结论可见且不会被静默覆盖；问答命中有效知识可直接给出带出处的答案，未命中会补查，否定反馈后不会在同一会话重复已排除的主张，新的问题修订仍能重新定位正确答案；任何节点失败或恢复不造成重复写入和越权；并行节点不写同一输出；修改流程定义或输入后不会默用旧 Receipt；原有 Engine/Collection 行为与 Gate 保持兼容。实现前不能将这些样板流程称为“现已开箱可用”。
