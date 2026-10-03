# 版本交付流程设计

**中立 Workflow：** `delivery-lifecycle@1.0.0`；**Profile：** `delivery-lifecycle`；**Extension：** `delivery-lifecycle-profile@1.0.0`。CardWorld 兼容身份 `engine-delivery` / `cardworld-engine-profile` 位于 `integrations/legacy-consumers/cardworld/`，不属于中立 Flow。

## 用途和合同

独立的 `implement` 命令在已批准计划上连续执行 `implement → scope → docs → quality`，包括质量修复、复审和最终 Gate，不能在实现 Feature 完成时结束。它与 `full` 路线共享质量收口规则，并从 Target 取得当前源码的 `QualityInventorySnapshot@2.0`。

独立 `implement` Run 启动时，将批准的 `proposedFeatures` 中本项目 `project-owned` 条目编译成逐包实施 Feature。编译器校验 ID、依赖和环，并按批准顺序串行执行；每包保留完整计划与当前提案，完成结果必须绑定提案 ID、逐条合同和验证证据。跨项目提案不获引擎写权限，外部制品与受保护发布证据可明确延后到对应集成或发布阶段。项目 Descriptor 的动作路径仍是写权限上界；提案路径提供实施指引，不因同一项目内必要的相邻源码文件改动要求用户重新规划。`scope` 等后续阶段仅在所有本项目实施包完成后开始。

适用于一个版本/功能的需求到交付闭环。输入是动作、目标版本、Feature、已批准的项目 Descriptor、执行模式、Gate Recipe，以及 Harness 从 Run Authority 派生的 `QualityTargetSnapshot`。`full` 路由顺序为 `intake → expansion → canonical → plan → implement → scope → docs → quality → review → deliver`。`requirements` 动作有四个 preset：`full`（默认，`intake → expansion → canonical`）、`expand-to-plan`（`intake → expansion → canonical → plan`）、`direct`（不扩展，`intake → canonical → plan`）、`plan-only`（`plan`）；`deliver` 可选择部分路线，其他阶段动作也可独立启动。端口依次使用 `delivery-intake-v1`、`delivery-expansion-v1`、`canonical-requirement-v1`、`delivery-plan-v1`、`delivery-implementation-v1`、`delivery-scope-v1`、`delivery-docs-v1`、`delivery-quality-v1`、`delivery-review-v1` 与 `delivery-receipt-v1`。节点由 `graph/definition.mjs` 声明，`nodes/delivery/` 生成 Feature，`policy/` 固定质量、评审和关闭规则。

结果须符合 Feature/Profile 合同并附来源和变更文件证据。`quality` 是质量检查点，`review`/`deliver` 是只读阶段；当前周期 P0–P3 必须关闭，必要人工 Decision 与最终 Gate Receipt 齐全才能关闭 Run。失败按 Attempt 预算处理；恢复只能遵守固定 Run 身份和 Epoch 规则。

版本 Target 的确定性身份为 `projectId + workflowId + target`。首次规划时 Target revision 为 0，Finding Ledger 可以为空；因此质量流程不要求 Project Descriptor 预先知道审查将发现的问题。后续独立的 `plan`、`implement`、`quality` 或 `deliver` 命令读取同一 Target 投影。终态 Run 中的 Finding、修复 Evidence 和 `knownFindingDispositions` 合并为下一 revision；活动且尚未完成的 Run 不进入新 Plan，避免心跳、Decision 或中间提交导致恢复 Plan 漂移。

进入 `implement`、`quality`、`full` 或 `deliver` 时，Harness 从 Target 生成不可变 `QualityInventorySnapshot@2.0`，绑定 Target revision/digest 和当前 Source digest。质量结果必须逐条处置快照中的既有 Finding，同时允许提交新的 Finding。源码变化保留 Ledger 历史但使旧 clean review 失效，必须在新 Source digest 上完成完整复审。旧 `policy.knownFindingInventories` 只作为迁移种子读取：迁移验证已注册声明自身并保留旧来源摘要，不再要求当前版本文档仍等于旧摘要；新快照独立绑定当前 Source digest，并记录原 inventory digest。新 Project Descriptor 不再生成旧字段。

权限边界不变：质量审查只读，修复由独立 Feature 执行；Flow 和 Extension 只返回 Intent/Event/Receipt，不直接写 Kernel Authority。Target 投影可从 Run Authority 和 Receipt 重建，不依赖模型上下文或插件内部状态。

## 公共质量机制

质量 Target 投影、Finding inventory、已知问题修复、独立 closeout、复审预算和 Gate 失败诊断由公共机制提供。版本流程保留原有单 Target 路由、准出 Decision 与 Gate 语义；批次流程按 item 作用域复用相同机制。抽取后的 Engine Plan、Run 与候选状态仍按原合同验证，等价性是准出条件。

## 开发准出后的预发布

`prerelease` 是 `release-preparation → release-documentation` 独立路线，入口必须有同一目标的 `development-complete` 准出凭证和已批准的 `routine-version-exit` Decision。Harness 核验该准出 Run 的不可变源码快照；进入预发布前的改动只能属于项目声明的文档、版本元数据或文档范围声明。它不新开质量复审，也不消耗既有质量目标的复审预算。版本元数据和文档修订在本路线完成后，重新运行 fresh 最终 Gate 与项目声明的真实打包 Gate。Gate 失败会停止候选封存并保留诊断证据，不自动追加质量审查。

预发布文档范围从业务仓声明文件读取，按完整目录递归展开，固定配置摘要和起始清单。文档节点逐一审计当前与历史文件，按源码和权威证据补齐旧遗漏；结果必须报告完整最终清单且无未解决问题。收口时 Harness 再次展开配置并与审计结果逐项核对，随后把最终源码摘要、文档逐文件摘要、实际制品逐文件摘要、开发准出和 Gate 回执封存成候选。制品复制至 Harness 数据根，以候选摘要定址，运行期构建目录不充当冻结候选。

正式晋升使用独立的 `h:<项目别名> release <版本>` Harness 命令。用户提交命令时，Hook 将当前候选摘要和修订号固定到短期 Coordinator 意图；Coordinator 核验绑定 Workflow、项目 checkout、预发布状态、候选摘要、修订号、冻结源码与制品字节，再将这次显式用户命令记录为精确候选的批准并晋升状态。底层 `version-release promote` 保留为状态 API，不要求用户组合查询与晋升脚本。操作不修改文档、版本号或制品，不执行新的 Gate 或复审；候选变化后旧命令不能晋升新候选。Git push 和外部分发仍为独立效果。

版本与批次的候选冻结、不可变制品清单、期望修订晋升和幂等命令共用发布存储机制；开发准出、文档范围、候选内容及正式批准规则由各流程单独实现。

## Node Task Contract 与 Prompt

十个节点分别发布完整 Task Contract，而不是共享“完成 action”式默认 Prompt：`intake` 负责来源化需求盘点，`expansion` 在采集后依据需求方向、已绑定文档与项目实际推导并补全需求（不臆造方向外范围），`canonical` 固化唯一需求合同，`plan` 生成覆盖/依赖/冲突图，`implement` 完成受限实现，`scope` 对账计划与实际范围，`docs` 同步外部合同，`quality` 执行只读 P0–P3 全量审查，`review` 独立评审，`deliver` 验证 Gate/Decision/Finding 后封存回执。`expansion` 阶段序号先于 `canonical`，因此不要求 `canonical-requirement-approved` 决策；用户批准的是补全后的 canonical 需求。每个合同包含角色、唯一目标、执行说明、输入、步骤、约束、验收和证据要求。

Workflow 编译器根据当前 route 的真实 `dependsOn` 自动把前序 typed output 绑定为 Task 输入，因此独立 `quality`、`plan` 等路线不会伪造不存在的上游，而 `full` 路线会逐阶段传递结果。编译后的 Feature 必须保留 Task、端口和值 Schema；Prompt Contract 1.3 显示 Task 摘要、已解析输入、结果合同和 Dispatch 摘要。质量修复、复审和动态开发 follow-up 也生成独立 Task Contract。

Workspace 可选择已发布的动作、目标、成员项目范围、Runtime、Gate Recipe、动作路径、Finding inventory 迁移种子和并发参数，不能重排节点或改写结果合同。CardWorld 的路径、脚本、旧命令及 `engine-delivery` 身份由 Legacy shim 显式提供；旧 Descriptor 必须绑定该 shim，新业务不得把它当作中立 Flow 的隐式别名。

## 命令级验收

合成入口 `npm run workspace:canary` 通过 CardWorld Legacy shim 解析 `h:engine full v1`，完成 Workspace 绑定、Target revision 0、Plan、预检、逐 Feature Dispatch/Submission、所需 Decision/Gate 和 `closed`。质量专项合成测试还必须覆盖：空 Ledger 首次启动、旧 inventory 迁移、跨 Run Finding 继承、修复后复审、Source digest 变化和活动 Run 不污染 Target。该命令不启动真实 CardWorld Run。验收记录须核对 Workflow ID、Run ID、Target digest、关闭状态与 Receipt；只通过单元测试不算闭环。
