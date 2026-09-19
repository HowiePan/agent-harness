# 版本交付流程设计

**能力目录：** `delivery-lifecycle`；**现行 Workflow ID：** `engine-delivery@1.0.0`；**Profile：** `engine-delivery`。目录名描述生命周期，现行 Extension 保留 CardWorld 兼容变体及其专属 Gate/脚本；不得把它当成任意项目的现成验收标准。

## 用途和合同

适用于一个版本/功能的需求到交付闭环。输入是动作、目标版本、Feature 和已批准的项目 Descriptor、执行模式、Gate Recipe。`full` 路由顺序为 `intake → canonical → plan → implement → scope → docs → quality → review → deliver`。`requirements` 和 `deliver` 可选择部分路线，其他阶段动作也可独立启动。节点由 `graph/definition.mjs` 声明，`nodes/delivery/` 生成该流程的 Feature，`policy/` 固定质量、评审和关闭规则。

结果须符合 Feature/Profile 合同并附来源和变更文件证据。`quality` 是质量检查点，`review`/`deliver` 是只读阶段；当前周期 P0–P3 必须关闭，必要人工 Decision 与最终 Gate Receipt 齐全才能关闭 Run。失败按 Attempt 预算处理；恢复只能遵守固定 Run 身份和 Epoch 规则。

Workspace 可选择已发布的动作、目标、成员项目范围和已开放的策略参数，不能重排节点或改 Gate。当前业务脚本和验收规则位于 CardWorld 变体，新的业务接入需提供自己的变体/Extension 和精确制品摘要。

## 命令级验收

合成入口 `npm run workspace:canary` 解析 `h:engine full v1`，完成 Workspace 绑定、Plan、预检、逐 Feature Dispatch/Submission、所需 Decision/Gate 和 `closed`。该命令不启动真实 CardWorld Run。验收记录须核对 Workflow ID、Run ID、关闭状态与 Receipt；只通过单元测试不算闭环。
