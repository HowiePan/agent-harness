# 版本交付流程设计

**中立 Workflow：** `delivery-lifecycle@1.0.0`；**Profile：** `delivery-lifecycle`；**Extension：** `delivery-lifecycle-profile@1.0.0`。CardWorld 兼容身份 `engine-delivery` / `cardworld-engine-profile` 位于 `integrations/legacy-consumers/cardworld/`，不属于中立 Flow。

## 用途和合同

适用于一个版本/功能的需求到交付闭环。输入是动作、目标版本、Feature、已批准的项目 Descriptor、执行模式、Gate Recipe，以及 Harness 从 Run Authority 派生的 `QualityTargetSnapshot`。`full` 路由顺序为 `intake → canonical → plan → implement → scope → docs → quality → review → deliver`。`requirements` 和 `deliver` 可选择部分路线，其他阶段动作也可独立启动。端口依次使用 `delivery-intake-v1`、`canonical-requirement-v1`、`delivery-plan-v1`、`delivery-implementation-v1`、`delivery-scope-v1`、`delivery-docs-v1`、`delivery-quality-v1`、`delivery-review-v1` 与 `delivery-receipt-v1`。节点由 `graph/definition.mjs` 声明，`nodes/delivery/` 生成 Feature，`policy/` 固定质量、评审和关闭规则。

结果须符合 Feature/Profile 合同并附来源和变更文件证据。`quality` 是质量检查点，`review`/`deliver` 是只读阶段；当前周期 P0–P3 必须关闭，必要人工 Decision 与最终 Gate Receipt 齐全才能关闭 Run。失败按 Attempt 预算处理；恢复只能遵守固定 Run 身份和 Epoch 规则。

版本 Target 的确定性身份为 `projectId + workflowId + target`。首次规划时 Target revision 为 0，Finding Ledger 可以为空；因此质量流程不要求 Project Descriptor 预先知道审查将发现的问题。后续独立的 `plan`、`implement`、`quality` 或 `deliver` 命令读取同一 Target 投影。终态 Run 中的 Finding、修复 Evidence 和 `knownFindingDispositions` 合并为下一 revision；活动且尚未完成的 Run 不进入新 Plan，避免心跳、Decision 或中间提交导致恢复 Plan 漂移。

进入 `quality`、`full` 或 `deliver` 时，Harness 从 Target 生成不可变 `QualityInventorySnapshot@2.0`，绑定 Target revision/digest 和当前 Source digest。质量结果必须逐条处置快照中的既有 Finding，同时允许提交新的 Finding。源码变化保留 Ledger 历史但使旧 clean review 失效，必须在新 Source digest 上完成完整复审。旧 `policy.knownFindingInventories` 只作为迁移种子读取：迁移验证已注册声明自身并保留旧来源摘要，不再要求当前版本文档仍等于旧摘要；新快照独立绑定当前 Source digest，并记录原 inventory digest。新 Project Descriptor 不再生成旧字段。

权限边界不变：质量审查只读，修复由独立 Feature 执行；Flow 和 Extension 只返回 Intent/Event/Receipt，不直接写 Kernel Authority。Target 投影可从 Run Authority 和 Receipt 重建，不依赖模型上下文或插件内部状态。

## Node Task Contract 与 Prompt

九个节点分别发布完整 Task Contract，而不是共享“完成 action”式默认 Prompt：`intake` 负责来源化需求盘点，`canonical` 固化唯一需求合同，`plan` 生成覆盖/依赖/冲突图，`implement` 完成受限实现，`scope` 对账计划与实际范围，`docs` 同步外部合同，`quality` 执行只读 P0–P3 全量审查，`review` 独立评审，`deliver` 验证 Gate/Decision/Finding 后封存回执。每个合同包含角色、唯一目标、执行说明、输入、步骤、约束、验收和证据要求。

Workflow 编译器根据当前 route 的真实 `dependsOn` 自动把前序 typed output 绑定为 Task 输入，因此独立 `quality`、`plan` 等路线不会伪造不存在的上游，而 `full` 路线会逐阶段传递结果。编译后的 Feature 必须保留 Task、端口和值 Schema；Prompt Contract 1.3 显示 Task 摘要、已解析输入、结果合同和 Dispatch 摘要。质量修复、复审和动态开发 follow-up 也生成独立 Task Contract。

Workspace 可选择已发布的动作、目标、成员项目范围、Runtime、Gate Recipe、动作路径、Finding inventory 迁移种子和并发参数，不能重排节点或改写结果合同。CardWorld 的路径、脚本、旧命令及 `engine-delivery` 身份由 Legacy shim 显式提供；旧 Descriptor 必须绑定该 shim，新业务不得把它当作中立 Flow 的隐式别名。

## 命令级验收

合成入口 `npm run workspace:canary` 通过 CardWorld Legacy shim 解析 `h:engine full v1`，完成 Workspace 绑定、Target revision 0、Plan、预检、逐 Feature Dispatch/Submission、所需 Decision/Gate 和 `closed`。质量专项合成测试还必须覆盖：空 Ledger 首次启动、旧 inventory 迁移、跨 Run Finding 继承、修复后复审、Source digest 变化和活动 Run 不污染 Target。该命令不启动真实 CardWorld Run。验收记录须核对 Workflow ID、Run ID、Target digest、关闭状态与 Receipt；只通过单元测试不算闭环。
