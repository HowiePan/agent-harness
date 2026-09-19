# 批次生产流程设计

**能力目录：** `batch-production`；**现行 Workflow ID：** `collection-batch-production@1.0.0`；**Profile：** `collection-batch`。当前 Extension 保留 Collection 领域规则与旧命令绑定；中性目录不意味着这些验收规则能直接用于其他项目。

## 用途和合同

适用于有批次 Barrier、批内项目依赖与冲突的生产。`full` 路由为每个 item 编译 `rules → produce → quality → review → accept`；另有 `rules`、`launch`、`produce`、`quality`、`review`、`accept`、`close` 动作。`graph/definition.mjs` 定义路线，`nodes/batch/` 生成 Feature，`policy/` 定义批次质量和验收条件。Barrier 只限制跨批次发车，批内按 Feature 依赖和冲突图决定串行或并行。

输入包含批次、项目项、依赖、共享能力归属和已批准 Descriptor；输出为逐项验收、批次状态及关闭 Receipt。Result/证据必须与当前 Feature 和批次身份相符。当前周期 P0–P3 问题必须关闭；人工验收 Decision、确定性 Gate 和批次关闭条件缺一不可。失败与恢复遵守通用 Attempt/Epoch 语义，不以旧状态字符串提升权威。

Workspace 只配置成员、目标、流程绑定和开放参数，不改变 Barrier 或验收图。新业务项目要提供自己的验收变体与制品，而不是复用 Collection 的游戏规则。

## 命令级验收

`npm run workspace:canary` 解析 `h:collection full B1`，经 Plan、预检、逐项 Dispatch/Submission、质量、人工 Decision、Gate 和批次关闭，到达 `closed`。合成批次用于协议验证，不触碰真实 Collection B1 Run。
